"""Publish an immutable, allowlisted development source snapshot, never live data.

Control-side command: no API, Host reload, credential lookup or Git mutation.
The workspace copy is an experiment input, not a second production source of truth.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import re

BASE = Path(__file__).resolve().parents[2]
WORKSPACE = Path(os.environ.get('DL_WORKSPACE', '.local/workspace'))
DIRS = ['runtime/browser', 'runtime/budget_guard', 'runtime/workspace_foundation',
        'runtime/time_host', 'runtime/long_term_memory', 'runtime/long_term_memory/bundle',
        'runtime/native_dsh', 'runtime/native_dsh/private-vault',
        'runtime/native_dsh/capabilities', 'runtime/native_dsh/capabilities/examples/hello',
        'runtime/native_dsh/capabilities/examples/mcp', 'runtime/native_dsh/digital-life',
        'runtime/desktop_persona', 'runtime/digital_life_preset', 'runtime/self_maintenance',
        'runtime/native_dsh/multi-life', 'runtime/native_dsh/multi-life/platform',
        'runtime/native_dsh/multi-life/supervisor', 'runtime/native_dsh/multi-life/budget',
        'runtime/native_dsh/multi-life/private-services', 'runtime/native_dsh/multi-life/life-services']
DIRS.append('runtime/native_dsh/multi-life/recent-events')
DIRS.extend(['runtime/desktop_persona/reference-service', 'runtime/desktop_persona/reference-ui'])
EXACT = ['README.md', 'runtime/native_bridge.py', 'runtime/windows_terminal.py',
         'runtime/native_dsh/home/profiles/persona/cordis.patch.yml',
         'runtime/browser/config.json', 'runtime/budget_guard/config.json',
         'runtime/long_term_memory/config.json', 'runtime/time_host/production-config.json']
SUFFIXES = {'.mjs', '.js', '.py', '.md', '.ts', '.tsx', '.css'}
# Narrow V1 delivery keeps owner data/configuration out of both candidates.
# Keys are candidate paths; all formal source locators are retained in manifest.
V1_EXACT = [
    'runtime/native_dsh/multi-life/platform/local-network.mjs',
    'runtime/native_dsh/multi-life/platform/local-network.test.mjs',
    'runtime/native_dsh/multi-life/platform/official-search.mjs',
    'runtime/native_dsh/multi-life/platform/official-search.md',
    'runtime/native_dsh/multi-life/platform/official-provider.mjs',
    'runtime/native_dsh/multi-life/budget/provenance.mjs',
    'runtime/native_dsh/multi-life/budget/provenance.test.mjs',
    'runtime/native_dsh/multi-life/budget/credentials.mjs',
    'runtime/native_dsh/capabilities/isolation.mjs',
    'runtime/budget_guard/provider_gate.mjs',
    'runtime/native_dsh/recovery/diagnostics.mjs',
    'runtime/native_dsh/recovery/tool-protocol.mjs',
    'runtime/key_output_guard/guard.mjs',
    'runtime/key_output_guard/detector.mjs',
    'runtime/native_dsh/multi-life/platform/dots-capability.mjs',
    'runtime/native_dsh/multi-life/platform/dots-capability.test.mjs',
    'runtime/native_dsh/multi-life/platform/v1-capabilities.mjs',
    'runtime/native_dsh/multi-life/platform/v1-capabilities.test.mjs',
    'runtime/native_dsh/multi-life/platform/v1-runtime.mjs',
    'runtime/native_dsh/multi-life/platform/v1-runtime.test.mjs',
    'runtime/native_dsh/multi-life/contracts.mjs',
    'runtime/workspace_foundation/terminal_bridge.py', 'runtime/windows_terminal.py',
    'runtime/self_maintenance/publish_sources.py',
    'runtime/self_maintenance/verify_sources.py', 'runtime/self_maintenance/README.md',
    'runtime/self_maintenance/change.mjs',
    'runtime/deepseek_billing/MAINTENANCE.md',
    'runtime/deepseek_billing/service/cache.mjs',
    'runtime/deepseek_billing/service/snapshots.mjs',
    'runtime/deepseek_billing/service/runtime.mjs',
    'runtime/deepseek_billing/service/errors.mjs',
    'runtime/deepseek_billing/service/cache.test.mjs',
    'runtime/deepseek_billing/service/snapshots.test.mjs',
]
V1_EXTERNAL_ROOT = WORKSPACE / 'development/plugins/persona-dots'
V1_EXTERNAL = ['bridge.mjs', 'slack.mjs', 'store.mjs', 'protocol.mjs',
               'plugin.mjs', 'slack-ui.mjs']
# These historical fixtures contain deliberately credential-shaped test
# samples. Keep the secret detector strict; publish production source instead.
EXCLUDE = {'runtime/budget_guard/verify-context-overflow.mjs',
           'runtime/native_dsh/multi-life/platform/legacy-human-timeline.test.mjs',
           'runtime/native_dsh/multi-life/platform/official-provider.test.mjs',
           'runtime/native_dsh/multi-life/supervisor/acceptance-tools.mjs',
           'runtime/native_dsh/multi-life/budget/test_credential_import.py',
           'runtime/native_dsh/multi-life/budget/test_usage.py'}
SECRET = re.compile(rb'\bsk-[A-Za-z0-9_-]{18,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def collect(base=BASE, scope='full', external_root=V1_EXTERNAL_ROOT):
    if scope == 'v1-capabilities':
        paths = {name: base / name for name in V1_EXACT}
        paths.update({'shared-source/persona-dots/' + name: external_root / name for name in V1_EXTERNAL})
        result = {}
        for name, path in sorted(paths.items()):
            if not path.is_file():
                raise ValueError('Required V1 source missing: ' + name)
            if any(p.is_symlink() or p.is_junction() for p in [path, *path.parents]):
                raise ValueError('Source link rejected: ' + name)
            data = path.read_bytes()
            if SECRET.search(data):
                raise ValueError('Possible secret; publication stopped: ' + name)
            result[name] = data
        return result
    if scope != 'full':
        raise ValueError('Unknown source scope')
    paths = {base / path for path in EXACT if (base / path).is_file()}
    for name in DIRS:
        directory = base / name
        if directory.is_dir():
            # Deliberately non-recursive: excludes protected, home, store, sessions,
            # profiles, .venv, attachments, reports and third-party dependencies.
            paths.update(p for p in directory.iterdir() if p.is_file()
                         and (p.suffix in SUFFIXES or p.name in {'package.json', 'requirements.txt', 'cordis.patch.yml'}))
    result = {}
    for path in sorted(paths):
        if path.relative_to(base).as_posix() in EXCLUDE:
            continue
        if any(p.is_symlink() or p.is_junction() for p in [path, *path.parents]):
            raise ValueError('Source link rejected: ' + str(path))
        data = path.read_bytes()
        if SECRET.search(data):
            raise ValueError('Possible secret; publication stopped: ' + path.relative_to(base).as_posix())
        result[path.relative_to(base).as_posix()] = data
    return result

def publish(workspace=WORKSPACE, base=BASE, scope='full', owner_life_id=None,
            external_root=V1_EXTERNAL_ROOT):
    files = collect(base, scope, external_root)
    hashes = {name: digest(data) for name, data in files.items()}
    generation = digest(json.dumps(hashes, sort_keys=True).encode())
    root = workspace / 'development/runtime-source' / generation
    if any(p.is_symlink() or p.is_junction() for p in [root, *root.parents]):
        raise ValueError('Destination link rejected')
    root.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        dest = root / name
        if any(p.is_symlink() or p.is_junction() for p in [dest, *dest.parents]):
            raise ValueError('Destination source link rejected: ' + name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            if dest.read_bytes() != data:
                raise ValueError('Existing source snapshot was edited; preserve it: ' + name)
        else:
            with dest.open('xb') as stream:
                stream.write(data)
    manifest = {'version': 1, 'generation': generation, 'sourceRoot': str(base),
                'purpose': 'development-only; copied code does not change the running Host',
                'files': hashes}
    if scope == 'v1-capabilities':
        manifest.update({'version': 2, 'scope': scope, 'owner_life_id': owner_life_id,
                         'sourcePaths': {name: str(external_root / name.removeprefix('shared-source/persona-dots/'))
                                         if name.startswith('shared-source/persona-dots/')
                                         else str(base / name) for name in files},
                         'excluded': ['connection', 'policy configuration', 'Core', 'Prompt', 'credentials',
                                      'database', 'billing/usage values', 'other life private records'],
                         'recovery': 'Keep previous generations. Candidate edits cannot change Host. Compare formal SHA256 before a narrow controlled publication or rollback.'})
        for name, source in manifest['sourcePaths'].items():
            if Path(source).read_bytes() != files[name]:
                raise ValueError('Formal source changed during publication; preserve candidate and retry: ' + name)
    target = root / 'manifest.json'
    encoded = (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    if target.exists() and target.read_bytes() != encoded:
        raise ValueError('Manifest modified; publication stopped')
    if not target.exists():
        target.write_bytes(encoded)
    pointer = workspace / 'development/runtime-source' / ('CURRENT.json' if scope == 'full' else 'V1_CAPABILITIES.json')
    if pointer.is_symlink() or pointer.is_junction():
        raise ValueError('Source pointer link rejected')
    metadata = {'generation': generation, 'root': str(root), 'manifest': str(target)}
    if scope != 'full':
        metadata.update({'scope': scope, 'owner_life_id': owner_life_id})
    pointer.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    result = {'passed': True, 'generation': generation, 'files': len(files), 'root': str(root)}
    if scope != 'full':
        result.update({'scope': scope, 'owner_life_id': owner_life_id, 'pointer': str(pointer),
                       'manifest': str(target), 'manifest_sha256': digest(encoded),
                       'guide': str(root / 'runtime/self_maintenance/README.md')})
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--workspace', type=Path, default=WORKSPACE)
    parser.add_argument('--scope', choices=['full', 'v1-capabilities'], default='full')
    parser.add_argument('--life-id', help='Resolve this owner workspace from the current production registry')
    parser.add_argument('--check', action='store_true', help='Read-only; show source count/hash without publishing')
    args = parser.parse_args()
    if args.life_id:
        registry = json.loads((BASE / 'runtime/multi_life_supervisor/registry/registry.json').read_text('utf-8'))
        life = registry.get('lives', {}).get(args.life_id)
        if registry.get('mode') != 'production' or not life:
            raise ValueError('Current production owner required')
        args.workspace = Path(life['deployment']['workspace'])
    if args.check:
        files = collect(scope=args.scope)
        hashes = {name: digest(data) for name, data in files.items()}
        result = {'passed': True, 'files': len(files), 'sourceRoot': str(BASE), 'scope': args.scope,
                  'generation': digest(json.dumps(hashes, sort_keys=True).encode()), 'workspace': str(args.workspace)}
    else:
        result = publish(args.workspace, scope=args.scope, owner_life_id=args.life_id)
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    main()
