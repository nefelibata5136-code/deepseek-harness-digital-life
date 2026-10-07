"""Protected, append-only local workspace versions. No model/network/background work."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import sys
import uuid

HERE = Path(__file__).resolve().parent
DEFAULT_WORKSPACE = Path('.local/workspace')
DEFAULT_STORE = HERE / 'protected' / 'persona'
SKIP_DIRS = {'.git', 'node_modules', '__pycache__', '.venv', 'venv', '.cache',
             '.terminal-tmp', 'credentials', '.credentials', 'secrets', 'cache', '.ssh', '.aws', '.azure'}
SKIP_NAMES = {'credentials.json', 'credentials.yml', 'credentials.yaml',
              'id_rsa', 'id_ed25519', '.ds_store', 'thumbs.db', '.npmrc', '.pypirc', '.netrc',
              'auth.json', 'cookies.json', 'cookies.txt'}
SKIP_SUFFIXES = {'.key', '.pem', '.p12', '.pfx', '.pyc', '.lock', '.pid',
                 '.db', '.sqlite', '.sqlite3', '.db-wal', '.db-shm',
                 '.sqlite-wal', '.sqlite-shm', '.sqlite3-wal', '.sqlite3-shm',
                 '.db-journal', '.sqlite-journal', '.sqlite3-journal', '.token', '.credentials'}
SECRET = re.compile(rb'(?im)\bsk-[A-Za-z0-9_-]{18,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|app[_-]?secret|password|access[_-]?token|refresh[_-]?token|cookie)\s*["\']?\s*[:=]\s*["\']?[^\s"\'\r\n,}]{8,}')


def now():
    return datetime.now(timezone.utc).isoformat()


def excluded(rel):
    p = Path(rel)
    return (any(s.casefold() in SKIP_DIRS or s.casefold().startswith('.env') for s in p.parts)
            or p.name.casefold() in SKIP_NAMES or p.suffix.casefold() in SKIP_SUFFIXES
            or p.name.casefold().endswith(('.lock.json', '.cookie', '.cookies')))


def linked(p):
    return p.is_symlink() or os.path.isjunction(p)


def atomic_json(path, value):
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with tmp.open('x', encoding='utf-8', newline='\n') as f:
        json.dump(value, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class Versions:
    def __init__(self, workspace=DEFAULT_WORKSPACE, store=DEFAULT_STORE):
        self.workspace = Path(workspace).absolute()
        self.store = Path(store).absolute()
        self.repo = self.store / 'history.git'
        if self.workspace == self.store or self.store.is_relative_to(self.workspace):
            raise ValueError('Version store must be outside workspace')
        for root in (self.workspace, self.store):
            for p in (root, *root.parents):
                if linked(p):
                    raise ValueError('Workspace/store ancestors cannot be links')

    def git(self, *args, data=None, check=True):
        # Never consult workspace .git/config, hooks, attributes or ignore files.
        env = {k: v for k, v in os.environ.items() if not k.startswith('GIT_')}
        env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_OPTIONAL_LOCKS='0', GIT_AUTHOR_NAME='Persona local snapshots',
                   GIT_AUTHOR_EMAIL='local@persona.invalid', GIT_COMMITTER_NAME='Persona local snapshots',
                   GIT_COMMITTER_EMAIL='local@persona.invalid')
        return subprocess.run(['git', '--git-dir=' + str(self.repo),
                               '-c', 'core.hooksPath=' + os.devnull,
                               '-c', 'core.autocrlf=false', *args], input=data,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                              cwd=self.store, check=check)

    @contextmanager
    def lock(self):
        self.store.mkdir(parents=True, exist_ok=True)
        with (self.store / 'operation.lock').open('a+b') as f:
            if f.tell() == 0:
                f.write(b'0')
                f.flush()
            f.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                yield
            finally:
                f.seek(0)
                if os.name == 'nt':
                    msvcrt.locking(f.fileno(), msvcrt.LK_UNLCK, 1)

    def scan(self, selected=None, safe_blobs=None):
        if not self.workspace.is_dir():
            raise ValueError('Workspace missing; refuse recording mass deletion')
        files, skipped = {}, []
        def inspect(p, before=None):
                rel = p.relative_to(self.workspace).as_posix()
                # scandir supplies Windows metadata with directory enumeration.
                # Reject symlinks/junctions before descending; keep the second
                # stat after reading bytes, exact hashing and secret checks.
                before = before if before is not None else p.lstat()
                if stat.S_ISLNK(before.st_mode) or getattr(before, 'st_reparse_tag', 0) == getattr(stat, 'IO_REPARSE_TAG_MOUNT_POINT', 0xA0000003):
                    skipped.append({'path': rel, 'reason': 'link-or-junction'})
                elif excluded(rel):
                    skipped.append({'path': rel, 'reason': 'excluded-path'})
                elif stat.S_ISDIR(before.st_mode):
                    walk(p)
                elif stat.S_ISREG(before.st_mode):
                    data = p.read_bytes()
                    after = p.stat()
                    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
                        raise RuntimeError('File changed during scan: ' + rel)
                    # Exact content identity with a previously protected blob
                    # proves its secret check already passed. Still read/hash all
                    # bytes: timestamps never grant permission to reuse a blob.
                    oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest().encode()
                    if (safe_blobs or {}).get(rel) != oid and SECRET.search(data):
                        skipped.append({'path': rel, 'reason': 'possible-secret-content'})
                    else:
                        files[rel] = data
                else:
                    skipped.append({'path': rel, 'reason': 'non-regular-file'})
        def walk(folder):
            with os.scandir(folder) as entries:
                for entry in sorted(entries, key=lambda e: e.name):
                    inspect(Path(entry.path), entry.stat(follow_symlinks=False))
        if selected is None:
            walk(self.workspace)
        else:
            p = self.workspace / selected
            # Do not follow a junction inserted into any ancestor since admission.
            if any(linked(a) for a in [p, *p.parents] if a.is_relative_to(self.workspace)):
                skipped.append({'path': selected, 'reason': 'link-or-junction'})
            elif p.exists():
                if p.is_dir():
                    raise ValueError('File snapshot target became a directory')
                inspect(p)
        return files, skipped

    def head(self):
        if not self.repo.is_dir():
            return None
        r = self.git('rev-parse', '--verify', 'refs/heads/snapshots', check=False)
        return r.stdout.decode().strip() if r.returncode == 0 else None

    def _snapshot(self, reason, context=None):
        if not self.repo.exists():
            self.git('init', '--bare', str(self.repo))
            self.git('config', 'gc.auto', '0')
            self.git('symbolic-ref', 'HEAD', 'refs/heads/snapshots')
        binding = self.store / 'workspace.json'
        if binding.exists():
            if json.loads(binding.read_text('utf-8'))['workspace'] != str(self.workspace):
                raise ValueError('Store bound to a different workspace')
        else:
            atomic_json(binding, {'workspace': str(self.workspace), 'created_at': now()})
        parent = self.head()
        policy_hash = hashlib.sha256(SECRET.pattern + repr((sorted(SKIP_DIRS), sorted(SKIP_NAMES), sorted(SKIP_SUFFIXES))).encode()).hexdigest()
        trust_path = self.store / 'validated-content-policy.json'
        try:
            trust = json.loads(trust_path.read_text('utf-8'))
        except (FileNotFoundError, json.JSONDecodeError):
            trust = {}
        trusted = trust.get('policy') == policy_hash and trust.get('commit') == parent
        existing = {}
        if parent:
            for row in self.git('ls-tree', '-rz', parent).stdout.split(b'\0'):
                if row:
                    meta, name = row.split(b'\t', 1)
                    existing[name.decode('utf-8')] = meta.split()[2]
        selected = None
        key = (context or {}).get('path_key', '*')
        if key != '*' and parent and trusted:
            target = Path(key).absolute()
            if target.is_relative_to(self.workspace):
                if not any(linked(a) for a in [target, *target.parents] if a.is_relative_to(self.workspace)):
                    target = target.resolve()
                selected = target.relative_to(self.workspace).as_posix()
                if os.name == 'nt':
                    # Admission keys are lowercased for Windows conflict checks;
                    # Git paths must retain the original case, including deletes.
                    selected = next((name for name in existing if name.casefold() == selected.casefold()), selected)
        files, skipped = self.scan(selected, existing if trusted else None)
        current = {rel: hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest().encode()
                   for rel, data in files.items()}
        same = (current == existing if selected is None else
                current.get(selected) == existing.get(selected))
        if parent and same:
            # Exact content comparison is complete. An unchanged index/tree
            # needs no staging files, Git index rebuild or commit plumbing.
            return self._receipt(reason, context, parent, parent, files, skipped, selected, policy_hash)
        # A known file changes only its own entry. Unknown operations and startup
        # still capture all files. Never use mtime-only caches for protected bytes.
        self.git('read-tree', parent if selected is not None else '--empty')
        entries = bytearray()
        if selected is not None and selected not in files:
            entries.extend(b'0 ' + b'0' * 40 + b'\t' + selected.encode('utf-8') + b'\0')
        if files:
            # Hash the exact scanned bytes, never re-read live workspace files.
            # One Git process avoids hundreds of Windows process launches per
            # snapshot. The temporary inputs stay in the protected version store.
            with tempfile.TemporaryDirectory(prefix='snapshot-blobs-', dir=self.store) as staging:
                stage = Path(staging)
                if not stage.resolve().is_relative_to(self.store.resolve()):
                    raise RuntimeError('Snapshot staging escaped protected store')
                paths, changed, objects_by_path = [], [], {}
                for index, (rel, data) in enumerate(files.items()):
                    oid = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest().encode()
                    if existing.get(rel) == oid:
                        objects_by_path[rel] = oid
                        continue
                    path = stage / str(index)
                    path.write_bytes(data)
                    paths.append(json.dumps(path.as_posix(), ensure_ascii=False).encode('utf-8') + b'\n')
                    changed.append(rel)
                objects = self.git('hash-object', '-w', '--no-filters', '--stdin-paths',
                                   data=b''.join(paths)).stdout.splitlines() if paths else []
                if len(objects) != len(changed) or any(not re.fullmatch(rb'[0-9a-f]{40}|[0-9a-f]{64}', oid) for oid in objects):
                    raise RuntimeError('Incomplete snapshot object batch; no history published')
                objects_by_path.update(zip(changed, objects))
                for rel, oid in objects_by_path.items():
                    entries.extend(b'100644 ' + oid + b'\t' + rel.encode('utf-8') + b'\0')
        if entries:
            self.git('update-index', '-z', '--index-info', data=bytes(entries))
        else:
            # Some Git versions return the empty tree ID from write-tree without
            # materializing its object. Store it before publishing any empty commit.
            self.git('hash-object', '-t', 'tree', '-w', '--stdin', data=b'')
        tree = self.git('write-tree').stdout.decode().strip()
        previous_tree = self.git('rev-parse', parent + '^{tree}').stdout.decode().strip() if parent else None
        commit = parent
        if tree != previous_tree:
            args = ['commit-tree', tree] + (['-p', parent] if parent else [])
            message = ('workspace: ' + reason + '\n\nCo-Authored-By: Codex <noreply@openai.com>\n').encode()
            commit = self.git(*args, data=message).stdout.decode().strip()
            self.git('update-ref', 'refs/heads/snapshots', commit, parent or '0' * 40)
        return self._receipt(reason, context, commit, parent, files, skipped, selected, policy_hash)

    def _receipt(self, reason, context, commit, parent, files, skipped, selected, policy_hash):
        receipt = {'observed_at': now(), 'reason': reason, 'context': context,
                   'commit': commit, 'new_commit': commit != parent, 'parent': parent,
                   'files': len(files), 'excluded': skipped,
                   'scope': selected if selected is not None else '*'}
        with (self.store / 'events.jsonl').open('a', encoding='utf-8') as f:
            f.write(json.dumps(receipt, ensure_ascii=False) + '\n')
            f.flush()
            os.fsync(f.fileno())
        # Cache permission is bound to both the exact tree and exclusion policy.
        # A crash or a policy change forces a fresh content check, never a guess.
        atomic_json(self.store / 'validated-content-policy.json', {'policy': policy_hash, 'commit': commit})
        return receipt

    def snapshot(self, reason='manual', context=None):
        with self.lock():
            marker = self.store / 'active-turn.json'
            if reason == 'harness-startup' and marker.exists():
                owner = json.loads(marker.read_text('utf-8'))['owner_pid']
                if process_alive(owner):
                    raise RuntimeError('Another live top-level turn owns this workspace')
            return self._snapshot(reason, context)

    def begin(self, session, turn, owner_pid):
        with self.lock():
            if self.file_markers():
                raise RuntimeError('File operations must finish or recover before a turn-wide writer starts')
            marker = self.store / 'active-turn.json'
            stale = json.loads(marker.read_text('utf-8')) if marker.exists() else None
            if stale and process_alive(stale['owner_pid']):
                raise RuntimeError('Workspace already has a live top-level turn')
            receipt = self._snapshot('recovered-interruption' if stale else 'before-turn', {'session': session, 'turn': turn})
            token = uuid.uuid4().hex
            atomic_json(marker, {'token': token, 'session': session, 'turn': turn,
                                 'owner_pid': owner_pid, 'started_at': now(), 'recovered': stale})
            return {**receipt, 'token': token, 'recovered_interruption': stale is not None}

    def file_markers(self):
        return list((self.store / 'active-file-operations').glob('*.json'))

    def begin_file(self, session, path_key, tool, owner_pid):
        with self.lock():
            if (self.store / 'active-turn.json').exists():
                raise RuntimeError('An existing turn marker must be recovered first')
            for path in self.file_markers():
                item = json.loads(path.read_text('utf-8'))
                if not process_alive(item['owner_pid']):
                    raise RuntimeError('Interrupted file operation must be recovered first')
                if item['path_key'] == '*' or path_key == '*' or item['path_key'] == path_key:
                    raise RuntimeError('File operation overlaps another live owner')
            token = uuid.uuid4().hex
            context = {'token': token, 'session': session, 'path_key': path_key,
                       'tool': tool, 'owner_pid': owner_pid, 'started_at': now()}
            receipt = self._snapshot('before-tool:' + tool, context)
            directory = self.store / 'active-file-operations'
            directory.mkdir(exist_ok=True)
            atomic_json(directory / (token + '.json'), context)
            return {**receipt, 'token': token}

    def end_file(self, token, reason):
        if not re.fullmatch(r'[0-9a-f]{32}', token):
            raise ValueError('Invalid file operation token')
        with self.lock():
            marker = self.store / 'active-file-operations' / (token + '.json')
            context = json.loads(marker.read_text('utf-8'))
            receipt = self._snapshot(reason, context)
            marker.unlink()
            return receipt

    def recover(self):
        with self.lock():
            marker = self.store / 'active-turn.json'
            stale = json.loads(marker.read_text('utf-8')) if marker.exists() else None
            if stale and process_alive(stale['owner_pid']):
                raise RuntimeError('A live turn owns workspace; stop it before recovering')
            file_markers = self.file_markers()
            operations = [json.loads(p.read_text('utf-8')) for p in file_markers]
            if any(process_alive(item['owner_pid']) for item in operations):
                raise RuntimeError('Live file operations must stop before recovering')
            receipt = self._snapshot('recovered-interruption' if stale or operations else 'harness-startup', {'turn': stale, 'file_operations': operations} if operations else stale)
            for path in file_markers:
                path.unlink()
            if stale:
                marker.unlink()
            return {**receipt, 'recovered_interruption': stale is not None}

    def end(self, token, reason='after-turn'):
        with self.lock():
            marker = self.store / 'active-turn.json'
            active = json.loads(marker.read_text('utf-8'))
            if active['token'] != token:
                raise ValueError('Turn token mismatch')
            receipt = self._snapshot(reason, active)
            marker.unlink()
            return receipt

    def tree(self, revision):
        # Verify a commit reachable from our append-only branch; no expressions/options accepted.
        if not re.fullmatch(r'[0-9a-f]{7,40}', revision):
            raise ValueError('Use a hexadecimal commit ID from log')
        oid = self.git('rev-parse', '--verify', revision + '^{commit}').stdout.decode().strip()
        self.git('merge-base', '--is-ancestor', oid, 'refs/heads/snapshots')
        result = {}
        for entry in self.git('ls-tree', '-rz', oid).stdout.split(b'\0'):
            if not entry:
                continue
            meta, rel = entry.split(b'\t', 1)
            result[rel.decode('utf-8')] = meta.split()[2].decode()
        return oid, result

    def status(self):
        files, skipped = self.scan()
        head = self.head()
        old = self.tree(head)[1] if head else {}
        changes = []
        for rel in sorted(files.keys() | old.keys()):
            blob = self.git('hash-object', '--stdin', data=files[rel]).stdout.decode().strip() if rel in files and head else None
            if rel not in old:
                changes.append({'path': rel, 'kind': 'added'})
            elif rel not in files:
                changes.append({'path': rel, 'kind': 'deleted-or-excluded'})
            elif blob != old[rel]:
                changes.append({'path': rel, 'kind': 'modified'})
        return {'workspace': str(self.workspace), 'store': str(self.store), 'head': head,
                'changes': changes, 'excluded': skipped, 'active_turn':
                json.loads((self.store / 'active-turn.json').read_text('utf-8')) if (self.store / 'active-turn.json').exists() else None}

    def restore(self, revision, selected=None, apply=False):
        oid, old = self.tree(revision)
        workspace_missing = not self.workspace.exists()
        current, skipped = ({}, []) if workspace_missing else self.scan()
        paths = [selected] if selected else sorted(old.keys() | current.keys())
        for rel in paths:
            p = Path(rel)
            if p.is_absolute() or '..' in p.parts or ':' in rel or excluded(rel) or p.as_posix() != rel or rel in ('', '.'):
                raise ValueError('Unsafe/excluded restore path')
            for ancestor in (self.workspace / p, *(self.workspace / p).parents):
                if ancestor == self.workspace.parent:
                    break
                if linked(ancestor):
                    raise ValueError('Restore through link denied')
            if rel not in old and rel not in current:
                raise ValueError('File absent in target/current version')
            if any(x['path'] == rel for x in skipped):
                raise ValueError('Cannot overwrite an excluded current file')
            if (self.workspace / p).exists() and not (self.workspace / p).is_file():
                raise ValueError('Restore target is a directory; restore to a separate directory first')
        plan = [{'path': p, 'action': 'restore' if p in old else 'remove', 'target_blob': old.get(p)} for p in paths]
        if not apply:
            return {'dry_run': True, 'target': oid, 'plan': plan}
        with self.lock():
            if (self.store / 'active-turn.json').exists() or self.file_markers():
                raise RuntimeError('Stop turn and snapshot/end or recover before restore')
            if workspace_missing:
                self.workspace.mkdir(parents=True, exist_ok=False)
            before = self._snapshot('before-restore', {'target': oid, 'file': selected})
            for rel in paths:
                p = self.workspace / rel
                if p.is_file() and p.read_bytes() != current.get(rel):
                    raise RuntimeError('Restore target changed; stop writers and retry')
                if rel in old:
                    data = self.git('cat-file', 'blob', old[rel]).stdout
                    if SECRET.search(data):
                        raise ValueError('Refuse restoring possible credential content')
                    p.parent.mkdir(parents=True, exist_ok=True)
                    tmp = p.with_name(p.name + '.' + uuid.uuid4().hex + '.restore-tmp')
                    tmp.write_bytes(data)
                    os.replace(tmp, p)
                elif p.is_file():
                    p.unlink()  # Only the reviewed explicit restore plan, never git clean.
            after = self._snapshot('after-restore', {'target': oid, 'file': selected})
            return {'dry_run': False, 'target': oid, 'plan': plan, 'before': before, 'after': after}


def process_alive(pid):
    if os.name == 'nt':
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x1000, False, int(pid))
        if not handle:
            return ctypes.get_last_error() == 5
        code = wintypes.DWORD()
        try:
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
        return True
    except ProcessLookupError:
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=DEFAULT_WORKSPACE)
    parser.add_argument('--store', type=Path, default=DEFAULT_STORE)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('init', 'snapshot', 'check', 'log', 'exclusions', 'recover'):
        sub = commands.add_parser(name)
        if name in ('init', 'snapshot'):
            sub.add_argument('--reason', default='initial-baseline' if name == 'init' else 'manual')
    sub = commands.add_parser('begin')
    sub.add_argument('--session', required=True)
    sub.add_argument('--turn', required=True)
    sub.add_argument('--owner-pid', type=int, required=True)
    sub = commands.add_parser('end')
    sub.add_argument('--token', required=True)
    sub.add_argument('--reason', default='after-turn')
    sub = commands.add_parser('begin-file')
    sub.add_argument('--session', required=True)
    sub.add_argument('--path-key', required=True)
    sub.add_argument('--tool', required=True)
    sub.add_argument('--owner-pid', type=int, required=True)
    sub = commands.add_parser('end-file')
    sub.add_argument('--token', required=True)
    sub.add_argument('--reason', default='after-file-operation')
    sub = commands.add_parser('diff')
    sub.add_argument('older')
    sub.add_argument('newer', nargs='?')
    sub = commands.add_parser('restore')
    sub.add_argument('revision')
    sub.add_argument('--file')
    sub.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    v = Versions(args.workspace, args.store)
    if args.command in ('init', 'snapshot'):
        result = v.snapshot(args.reason)
    elif args.command == 'begin':
        result = v.begin(args.session, args.turn, args.owner_pid)
    elif args.command == 'end':
        result = v.end(args.token, args.reason)
    elif args.command == 'begin-file':
        result = v.begin_file(args.session, args.path_key, args.tool, args.owner_pid)
    elif args.command == 'end-file':
        result = v.end_file(args.token, args.reason)
    elif args.command == 'recover':
        result = v.recover()
    elif args.command == 'check':
        result = v.status()
    elif args.command == 'log':
        result = {'head': v.head(), 'log': v.git('log', '--format=%H %cI %s', 'refs/heads/snapshots').stdout.decode('utf-8') if v.head() else ''}
    elif args.command == 'diff':
        a, _ = v.tree(args.older)
        b, _ = v.tree(args.newer or v.head())
        result = {'older': a, 'newer': b, 'diff': v.git('diff', '--no-ext-diff', '--no-textconv', a, b, '--').stdout.decode('utf-8', errors='replace')}
    elif args.command == 'restore':
        result = v.restore(args.revision, args.file, args.apply)
    else:
        result = {'directories': sorted(SKIP_DIRS), 'names': sorted(SKIP_NAMES), 'suffixes': sorted(SKIP_SUFFIXES), 'content': 'suspected keys/password/token/cookie/private-key content', 'other': 'links/junctions, empty directories, filesystem metadata/ACL, data outside workspace'}
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
