"""Deployment lifecycle for one owned Chrome profile; never removes a profile."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request
import uuid
import zipfile
import hashlib
import struct
from functools import lru_cache

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / 'config.json').read_text(encoding='utf-8'))
ROOT = Path(CONFIG['private_root'])
PROFILE = Path(CONFIG['profile'])
ENDPOINT = f"http://127.0.0.1:{CONFIG['cdp_port']}"


def owned_processes():
    import psutil
    found = []
    for p in psutil.process_iter(['pid', 'exe', 'cmdline']):
        try:
            if p.info['exe'] and Path(p.info['exe']).resolve() == Path(CONFIG['chrome']).resolve():
                args = p.info['cmdline'] or []
                if any(a.startswith('--user-data-dir=') and Path(a.split('=', 1)[1]).resolve() == PROFILE.resolve() for a in args):
                    found.append(p)
        except (psutil.Error, OSError):
            pass
    return found


@lru_cache(maxsize=1)
def prepare():
    if not PROFILE.is_relative_to(ROOT) or PROFILE == ROOT:
        raise RuntimeError('Profile must be a dedicated child of private_root')
    for p in [ROOT, PROFILE]:
        if p.is_symlink() or os.path.isjunction(p):
            raise RuntimeError('Profile roots must not be links')
        p.mkdir(parents=True, exist_ok=True)
    # Preserve the existing legacy restriction ACE without importing a private
    # helper from the terminal. Full-access terminal no longer has that helper.
    # This is the same historical SID calculation, not a new terminal sandbox.
    import win32security, win32con
    workspace = Path(os.environ.get('DL_WORKSPACE', '.local/workspace'))
    words = struct.unpack('<III', hashlib.sha256(str(workspace).casefold().encode('utf-8')).digest()[:12])
    sid = win32security.ConvertStringSidToSid('S-1-5-21-' + '-'.join(str(word) for word in words) + '-42604')
    dacl = win32security.ACL()
    flags = win32con.OBJECT_INHERIT_ACE | win32con.CONTAINER_INHERIT_ACE
    dacl.AddAccessDeniedAceEx(win32security.ACL_REVISION, flags, 0x1F01FF, sid)
    user = win32security.GetTokenInformation(win32security.OpenProcessToken(__import__('win32api').GetCurrentProcess(), win32con.TOKEN_QUERY), win32security.TokenUser)[0]
    for allowed in [user, win32security.ConvertStringSidToSid('S-1-5-18'), win32security.ConvertStringSidToSid('S-1-5-32-544')]:
        dacl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, 0x1F01FF, allowed)
    win32security.SetNamedSecurityInfo(str(ROOT), win32security.SE_FILE_OBJECT,
        win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION,
        None, None, dacl, None)
    identity = ROOT / 'browser-identity.json'
    if not identity.exists():
        identity.write_text(json.dumps({'id': str(uuid.uuid4()), 'profile': str(PROFILE)}), encoding='utf-8')
    return json.loads(identity.read_text(encoding='utf-8'))


def status():
    prepare()
    ready = False
    try:
        with urllib.request.urlopen(ENDPOINT + '/json/version', timeout=2) as r:
            version = json.load(r)
        ready = bool(owned_processes()) and 'Chrome/' in version.get('Browser', '')
    except OSError:
        pass
    # The identity reported to tools names the configured owned browser. Use a
    # deterministic tag across control-side and scheduled Host process scopes;
    # the private archive UUID remains untouched for backup provenance.
    identity = uuid.uuid5(uuid.NAMESPACE_URL, 'persona-chrome|' + str(PROFILE.resolve()).casefold()
                         + '|' + str(Path(CONFIG['chrome']).resolve()).casefold())
    return {'identity': str(identity), 'identity_basis':'fixed Chrome executable and dedicated profile path',
            'profile': str(PROFILE), 'running': bool(owned_processes()), 'cdp_ready': ready}


def ensure():
    if status()['cdp_ready']:
        return ENDPOINT
    if owned_processes():
        raise RuntimeError('Owned Chrome is running without its configured CDP endpoint; close it manually first')
    # Refuse a port owned by any other browser/service.
    import socket
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', CONFIG['cdp_port']))
    env = {k: v for k, v in os.environ.items() if k.upper() in {
        'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'COMSPEC'}}
    subprocess.Popen([CONFIG['chrome'], f'--user-data-dir={PROFILE}', '--profile-directory=Default',
        f"--remote-debugging-port={CONFIG['cdp_port']}", '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', 'about:blank'], env=env,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP)
    for _ in range(100):
        if status()['cdp_ready']:
            return ENDPOINT
        time.sleep(0.2)
    raise RuntimeError('Owned Chrome did not expose its endpoint')


def stop():
    import win32gui, win32process, win32con
    ids = {p.pid for p in owned_processes()}
    def close(hwnd, _):
        if win32process.GetWindowThreadProcessId(hwnd)[1] in ids:
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    win32gui.EnumWindows(close, None)
    for _ in range(100):
        if not owned_processes():
            return
        time.sleep(0.2)
    raise RuntimeError('Chrome did not close gracefully; no forced termination or backup attempted')


def backup():
    prepare()
    if owned_processes():
        raise RuntimeError('Close owned Chrome first; backup refuses an open profile')
    target = ROOT / 'backups' / (time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8] + '.zip')
    target.parent.mkdir(exist_ok=True)
    hashes = {}
    with zipfile.ZipFile(target, 'x', compression=zipfile.ZIP_DEFLATED) as z:
        for p in PROFILE.rglob('*'):
            if p.is_symlink() or os.path.isjunction(p):
                raise RuntimeError('Backup refuses linked files')
            if p.is_file():
                rel = p.relative_to(PROFILE).as_posix()
                data = p.read_bytes()
                hashes[rel] = hashlib.sha256(data).hexdigest()
                z.writestr('profile/' + rel, data)
        z.writestr('manifest.json', json.dumps({'identity': prepare()['id'], 'sha256': hashes}))
    return {'backup': str(target), 'files': len(hashes), 'sha256': hashlib.sha256(target.read_bytes()).hexdigest()}


def restore(archive):
    import shutil
    prepare()
    archive = Path(archive).resolve()
    if not archive.is_relative_to((ROOT / 'backups').resolve()) or owned_processes():
        raise RuntimeError('Restore requires a private backup and closed owned Chrome')
    staging = ROOT / ('restore-' + uuid.uuid4().hex)
    with zipfile.ZipFile(archive) as z:
        manifest = json.loads(z.read('manifest.json'))
        if manifest['identity'] != prepare()['id']:
            raise RuntimeError('Backup belongs to another browser identity')
        for rel, expected in manifest['sha256'].items():
            p = (staging / rel).resolve()
            if not p.is_relative_to(staging.resolve()):
                raise RuntimeError('Unsafe backup path')
            data = z.read('profile/' + rel)
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError('Backup hash mismatch')
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
    preserved = ROOT / ('profile-before-restore-' + time.strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8])
    PROFILE.rename(preserved)
    shutil.move(str(staging), str(PROFILE))
    return {'restored': str(PROFILE), 'previous_profile_preserved': str(preserved)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['open', 'status', 'stop', 'backup', 'restore', 'resume'])
    parser.add_argument('--archive')
    args = parser.parse_args()
    if args.action == 'open':
        ensure(); result = status()
    elif args.action == 'stop':
        stop(); result = status()
    elif args.action == 'backup':
        result = backup()
    elif args.action == 'restore':
        result = restore(args.archive)
    elif args.action == 'resume':
        prepare()
        (ROOT / 'human-pending.json').unlink(missing_ok=True)
        result = {'human_returned_control': True}
    else:
        result = status()
    print(json.dumps(result, ensure_ascii=False))
