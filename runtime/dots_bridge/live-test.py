"""Bounded maintainer test client. Always address an independent Harness Session."""
import json
from pathlib import Path
import sys
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
STATE = ROOT.parent / 'native_dsh/host-state/.host-control.json'
REPORTS = ROOT.parent.parent / 'reports/dots_bridge/live'


def host(method, route, data=None):
    state = json.loads(STATE.read_text(encoding='utf-8'))
    request = urllib.request.Request(f"http://127.0.0.1:{state['port']}{route}",
        method=method, data=None if data is None else json.dumps(data).encode(),
        headers={'Authorization': 'Bearer ' + state['token'], 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=1200) as response:
        return json.load(response)


def main():
    command = sys.argv[1]
    REPORTS.mkdir(parents=True, exist_ok=True)
    if command == 'status':
        value = host('GET', '/status')
        print(json.dumps({k: value.get(k) for k in ['ready', 'busy', 'activeSessionIds', 'budget']}))
    elif command == 'create':
        value = host('POST', '/tasks', {'requestId': str(uuid.uuid4()), 'title': sys.argv[2]})
        assert not value.get('existing') and value.get('sessionId')
        (REPORTS / (value['sessionId'] + '-session.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(value, ensure_ascii=False))
    elif command == 'prompt':
        session = sys.argv[2]
        # A receipt produced by create is mandatory; never fall back to main.
        receipt = json.loads((REPORTS / (session + '-session.json')).read_text(encoding='utf-8'))
        assert receipt['sessionId'] == session and not receipt.get('existing')
        assert session != json.loads(STATE.read_text(encoding='utf-8'))['sessionId']
        request_id = str(uuid.uuid4())
        text = Path(sys.argv[3]).read_text(encoding='utf-8')
        path = REPORTS / (request_id + '.json')
        record = {'sessionId': session, 'requestId': request_id, 'text': text, 'status': 'prepared'}
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        value = host('POST', '/prompt', record)
        record.update(status='returned', response=value)
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'report': str(path), **value}, ensure_ascii=False))
    else:
        raise ValueError('Unsupported command')


if __name__ == '__main__':
    main()
