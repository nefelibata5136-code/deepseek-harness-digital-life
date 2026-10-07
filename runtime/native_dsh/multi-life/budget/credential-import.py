"""Host-only secret intake. Never return keys, key hashes, or input text."""
from pathlib import Path
import argparse
import importlib.util
import json
import os
import re
import sys
import tempfile

HERE = Path(__file__).resolve().parent
DEFAULT_INPUT = Path(os.environ.get('LOCALAPPDATA', '')) / 'PersonaHost/secret-input/multi-life-deepseek-keys.json'
DEFAULT_REGISTRY = HERE.parents[2] / 'multi_life_supervisor/registry/registry.json'
STAGE = 'start'

class IntakeError(Exception):
    pass

def reference(life_id):
    if not re.fullmatch(r'life-[a-zA-Z0-9-]{1,128}', life_id):
        raise IntakeError('INVALID_LIFE_ID')
    return 'DL_LIFE_DEEPSEEK_' + life_id[5:].replace('-', '_').upper()

def load_lives(registry):
    value = json.loads(Path(registry).read_text(encoding='utf-8-sig'))
    lives = value.get('lives', {})
    rows = list(lives.values()) if isinstance(lives, dict) else lives
    if value.get('mode') != 'production' or not rows:
        raise IntakeError('PRODUCTION_REGISTRY_REQUIRED')
    return {row['lifeId']: reference(row['lifeId']) for row in rows}

def backend():
    spec = importlib.util.spec_from_file_location('host_credentials', HERE.parents[1] / 'capabilities/credentials.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.operation

def intake(path, lives, operation, apply=False, clear_stored=False):
    global STAGE
    # Resolve Windows junctions once. tempfile resolves its directory, whereas
    # os.replace cannot cross a C: alias / D: target even for the same file.
    path = Path(path).resolve(strict=True)
    STAGE = 'read_intake'
    original = path.read_bytes()
    value = json.loads(original.decode('utf-8-sig'))
    STAGE = 'validate_identity'
    rows = value.get('credentials')
    if value.get('schemaVersion') != 1 or not isinstance(rows, list) or len(rows) != len(lives):
        raise IntakeError('INTAKE_SCHEMA_MISMATCH')
    seen = set()
    for row in rows:
        life = row.get('life_id')
        if life not in lives or life in seen or row.get('host_ref') != lives[life]:
            raise IntakeError('LIFE_REFERENCE_MISMATCH')
        seen.add(life)
        key = row.get('api_key')
        if not isinstance(key, str) or len(key) > 8192:
            raise IntakeError('INVALID_SECRET_INPUT')
    ready = all(len(row['api_key']) >= 16 and not any(c.isspace() for c in row['api_key']) for row in rows)
    distinct = len({row['api_key'] for row in rows}) == len(rows)
    STAGE = 'describe_broker'
    metadata = [dict(life_id=row['life_id'], host_ref=row['host_ref'],
                     configured=bool(operation('describe', row['host_ref']).get('configured'))) for row in rows]
    if not apply and not clear_stored:
        return dict(action='check', intake_ready=ready and distinct, credentials=metadata, secret_values_returned=False)
    if not ready:
        raise IntakeError('ALL_LIFE_KEYS_REQUIRED')
    if not distinct:
        raise IntakeError('LIFE_KEYS_MUST_BE_DISTINCT')
    # Store through the existing Host broker only. A partial broker failure keeps
    # the intake intact so no key is lost; existing credentials are never copied.
    if clear_stored:
        STAGE = 'verify_stored_match'
        for row in rows:
            stored = operation('resolve', row['host_ref'])
            if not stored or stored.get('value') != row['api_key']:
                raise IntakeError('STORED_CREDENTIAL_MISMATCH_INTAKE_RETAINED')
    else:
        STAGE = 'store_broker'
        for row in rows:
            result = operation('set', row['host_ref'], row['api_key'])
            if not result.get('configured'):
                raise IntakeError('BROKER_STORE_FAILED_INTAKE_RETAINED')
    STAGE = 'compare_intake'
    if path.read_bytes() != original:
        raise IntakeError('INTAKE_CHANGED_KEYS_STORED_FILE_RETAINED')
    for row in rows:
        row['api_key'] = ''
    STAGE = 'create_empty_replacement'
    fd, temporary = tempfile.mkstemp(prefix=path.name + '.', suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        STAGE = 'final_compare'
        if path.read_bytes() != original:
            raise IntakeError('INTAKE_CHANGED_KEYS_STORED_FILE_RETAINED')
        STAGE = 'atomic_clear'
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    STAGE = 'complete'
    return dict(action='clear-stored' if clear_stored else 'import', imported=True, intake_cleared=True,
                credentials=[dict(life_id=row['life_id'], host_ref=row['host_ref'], configured=True) for row in rows],
                secret_values_returned=False)

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=DEFAULT_INPUT)
    parser.add_argument('--registry', type=Path, default=DEFAULT_REGISTRY)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true')
    mode.add_argument('--import', dest='apply', action='store_true')
    mode.add_argument('--clear-stored', action='store_true', help='Clear only after exact Host-side comparison with stored credentials')
    options = parser.parse_args()
    try:
        result = intake(options.input, load_lives(options.registry), backend(), options.apply, options.clear_stored)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        # Do not print arbitrary parser/OS/broker exceptions or a secret input.
        print(json.dumps({'ok': False, 'code': str(error) if isinstance(error, IntakeError) else 'HOST_CREDENTIAL_INTAKE_FAILED',
                          'stage': STAGE, 'error_type': type(error).__name__, 'winerror': getattr(error, 'winerror', None),
                          'errno': getattr(error, 'errno', None)}))
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
