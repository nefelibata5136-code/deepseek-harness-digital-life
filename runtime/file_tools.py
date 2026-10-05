"""Protected file and terminal transport for official DSH. No model loop or memory injection."""
from __future__ import annotations

import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import uuid
from zoneinfo import ZoneInfo

BASE = Path(__file__).resolve().parents[1]
WORKSPACE = Path(os.environ.get('DL_WORKSPACE', '.local/workspace'))
LEGACY = Path(os.environ.get('DL_DATA', '.local')) / 'legacy'
HISTORY = Path(os.environ.get('DL_DATA', '.local')) / 'history'
SESSIONS = Path(os.environ.get('DL_DATA', '.local')) / 'tool-sessions'
SECRET = re.compile(r'\bsk-[A-Za-z0-9_-]{18,}|(?im:^\s*(?:DEEPSEEK_API_KEY|VOLC_TTS_API_KEY|APP_SECRET|COMPANION_PASSWORD|DASHSCOPE_API_KEY)\s*[=:]\s*[\"\']?[^\s\"\']{8,})')


def now():
    return datetime.now(ZoneInfo('Asia/Shanghai')).isoformat()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def atomic_bytes(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with temp.open('xb') as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(temp, path)


def save_json(path, data):
    atomic_bytes(path, (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def secure_path(root, relative, *, write=False):
    root = Path(root).absolute()
    rel = Path(relative)
    # Refuse device/ADS, drive-relative paths, links and traversal before resolve.
    if not isinstance(relative, str) or rel.is_absolute() or rel.drive or ':' in relative or '\x00' in relative or '..' in rel.parts:
        raise ValueError('Use a relative path inside the selected area')
    candidate = root / rel
    for node in (root, *[root.joinpath(*rel.parts[:i]) for i in range(1, len(rel.parts) + 1)]):
        if node.is_symlink() or (hasattr(os.path, 'isjunction') and os.path.isjunction(node)):
            raise PermissionError('Links and junctions are not allowed by file tools')
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root.resolve()):
        raise PermissionError('Path escapes selected area')
    if any(part.lower().startswith('.env') for part in rel.parts) or any(part.lower() in (
            'credentials', 'credentials.json', '.credentials.yaml', '.credentials.yml',
            'auth.json', 'id_rsa', 'id_ed25519') for part in rel.parts):
        raise PermissionError('Credential files are excluded from model file tools')
    if write and resolved == root.resolve():
        raise ValueError('Specify a file path')
    return resolved


def text_file(path, *, full_access=False):
    data = path.read_bytes()
    if b'\x00' in data:
        raise ValueError('Binary asset: metadata only; byte count=' + str(len(data)))
    try:
        text = data.decode('utf-8-sig')
    except UnicodeError:
        raise ValueError('Not UTF-8 text; binary/other encoding asset remains preserved') from None
    if not full_access and SECRET.search(text):
        raise PermissionError('Entire credential-bearing file is excluded from model reads')
    return text

class FileTools:
    def __init__(self, session, *, full_access=False):
        self.full_access = full_access
        self.session = Path(session)
        self.state = load_json(self.session / 'state.json')

    def save(self):
        self.state['updated_at'] = now()
        save_json(self.session / 'state.json', self.state)

    def area(self, area, relative):
        roots = {'workspace': WORKSPACE, 'history': HISTORY, 'legacy': LEGACY, 'session': self.session, 'controls': BASE}
        if area not in roots:
            raise ValueError('Unknown area')
        if not self.full_access and area == 'controls' and Path(relative).parts and Path(relative).parts[0] not in ('runtime', 'reports', 'README.md'):
            raise PermissionError('Recovery, configuration secrets and private sessions are protected')
        if self.full_access:
            return (roots[area] / relative).resolve()
        return secure_path(roots[area], relative)

    def list_files(self, area, path='', offset=0):
        if offset < 0:
            raise ValueError('Negative offset')
        directory = self.area(area, path)
        entries = []
        for p in sorted(directory.iterdir(), key=lambda p: p.name.casefold()):
            try:
                self.area(area, str(p.relative_to({'workspace': WORKSPACE, 'history': HISTORY, 'legacy': LEGACY, 'session': self.session, 'controls': BASE}[area])))
            except (PermissionError, ValueError):
                continue
            entries.append({'name': p.name, 'directory': p.is_dir(), 'bytes': p.stat().st_size if p.is_file() else None})
        page = entries[offset:offset + 100]
        return {'entries': page, 'total': len(entries), 'next_offset': offset + len(page) if offset + len(page) < len(entries) else None}

    def read_file(self, area, path, offset=0, limit=10000):
        if offset < 0 or not 1 <= limit <= 20000:
            raise ValueError('Invalid read bounds')
        p = self.area(area, path)
        text = text_file(p, full_access=self.full_access)
        end = min(offset + limit, len(text))
        return {'path': path, 'sha256': digest(p.read_bytes()), 'offset': offset, 'content': text[offset:end],
                'total_characters': len(text), 'next_offset': end if end < len(text) else None}

    def search_history(self, query, cursor='', limit=20):
        if not query or not 1 <= limit <= 50:
            raise ValueError('Nonempty query and limit 1..50 required')
        files = sorted({d['path'] for d in load_json(HISTORY / 'catalog.json')})
        position = json.loads(base64.urlsafe_b64decode(cursor).decode()) if cursor else {'file': 0, 'line': 1}
        hits = []
        for index in range(position['file'], len(files)):
            p = secure_path(HISTORY, files[index])
            try:
                text = text_file(p, full_access=self.full_access)
            except (ValueError, PermissionError):
                continue
            start_line = position['line'] if index == position['file'] else 1
            char_offset = 0
            for line_number, line in enumerate(text.splitlines(keepends=True), 1):
                current_offset = char_offset
                char_offset += len(line)
                if line_number < start_line or query not in line:
                    continue
                where = line.index(query)
                excerpt_start = max(0, where - 200)
                excerpt = line[excerpt_start:excerpt_start + 2000]
                hits.append({'path': files[index], 'line': line_number, 'offset': current_offset,
                             'excerpt': excerpt, 'excerpt_truncated': len(line) > len(excerpt),
                             'read_offset': current_offset + excerpt_start})
                if len(hits) == limit:
                    next_cursor = base64.urlsafe_b64encode(json.dumps({'file': index, 'line': line_number + 1}).encode()).decode()
                    return {'hits': hits, 'next_cursor': next_cursor, 'complete': False}
        return {'hits': hits, 'next_cursor': None, 'complete': True}

    def receipt_path(self, call_id):
        return self.session / 'receipts' / (digest(call_id.encode()) + '.json')

    def write_file(self, path, content, _call_id):
        p = secure_path(WORKSPACE, path, write=True)
        data = content.encode('utf-8')
        if SECRET.search(content):
            raise PermissionError('Do not copy credentials into the workspace')
        rp = self.receipt_path(_call_id)
        if rp.exists():
            receipt = load_json(rp)
            if receipt['status'] == 'complete':
                return receipt['result']
            actual = digest(p.read_bytes()) if p.exists() else None
            if actual == receipt['after_sha256']:
                receipt['status'] = 'complete'
                receipt['result']['recovered_after_interruption'] = True
                save_json(rp, receipt)
                return receipt['result']
            raise RuntimeError('Interrupted write has ambiguous status; review local receipt before continuing')
        previous = p.read_bytes() if p.exists() else None
        version = self.session / 'versions' / digest(_call_id.encode())
        version.mkdir(parents=True, exist_ok=False)
        if previous is not None:
            atomic_bytes(version / 'before.bin', previous)
        atomic_bytes(version / 'after.bin', data)
        result = {'path': path, 'created': previous is None, 'bytes': len(data), 'sha256': digest(data), 'version_id': version.name}
        receipt = {'status': 'started', 'tool': 'write_file', 'path': str(p),
                   'before_sha256': digest(previous) if previous is not None else None,
                   'after_sha256': digest(data), 'result': result, 'observed_at': now()}
        save_json(rp, receipt)
        p.parent.mkdir(parents=True, exist_ok=True)
        # Check links again immediately before the replace.
        secure_path(WORKSPACE, path, write=True)
        atomic_bytes(p, data)
        receipt['status'] = 'complete'
        save_json(rp, receipt)
        return result

    def workspace_snapshot(self, destination):
        metadata = []
        for p in WORKSPACE.rglob('*'):
            if not p.is_file() or '.terminal-tmp' in p.relative_to(WORKSPACE).parts:
                continue
            rel = p.relative_to(WORKSPACE)
            secure_path(WORKSPACE, str(rel))
            data = p.read_bytes()
            atomic_bytes(destination / 'files' / rel, data)
            metadata.append({'path': rel.as_posix(), 'sha256': digest(data), 'bytes': len(data)})
        save_json(destination / 'manifest.json', metadata)
        return metadata

    def terminal(self, command, timeout=30, _call_id=''):
        verify_terminal()
        rp = self.receipt_path(_call_id)
        if rp.exists():
            receipt = load_json(rp)
            if receipt['status'] == 'complete':
                return receipt['result']
            raise RuntimeError('Interrupted terminal action is not automatically retried; inspect the workspace and receipt')
        version = self.session / 'versions' / digest(_call_id.encode())
        before = self.workspace_snapshot(version / 'before')
        save_json(rp, {'status': 'started', 'tool': 'terminal', 'observed_at': now(), 'command': command})
        import windows_terminal
        result = windows_terminal.run(command, WORKSPACE, timeout=timeout)
        after = self.workspace_snapshot(version / 'after')
        result['version_id'] = version.name
        result['before_files'] = before
        result['after_files'] = after
        if SECRET.search(result.get('stdout', '') + '\n' + result.get('stderr', '')):
            result['stdout'] = ''
            result['stderr'] = 'Credential-bearing terminal output withheld in full'
        save_json(rp, {'status': 'complete', 'tool': 'terminal', 'result': result, 'observed_at': now()})
        return result

    def dispatch(self, call):
        name = call['function']['name']
        args = json.loads(call['function']['arguments'])
        if name not in ('list_files', 'read_file', 'search_history', 'write_file', 'terminal'):
            raise ValueError('Unknown tool')
        if name in ('write_file', 'terminal'):
            args['_call_id'] = call['id']
        return getattr(self, name)(**args)


def sanitize(text, key=''):
    if key:
        text = text.replace(key, '[credential withheld]')
    return SECRET.sub('[credential withheld]', text)


def api_key():
    key = os.environ.get('DEEPSEEK_API_KEY')
    if not key:
        raise RuntimeError('DEEPSEEK_API_KEY is required in the Host process')
    return key

def verify_terminal():
    from windows_terminal import run
    if not callable(run):
        raise RuntimeError('Terminal implementation is missing')
