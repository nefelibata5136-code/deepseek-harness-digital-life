"""Read-only local JSONL projection of native DSH records; no network or ledger.

Native complete sessions remain authoritative/private. This prints whole records,
never appends output or writes sources. Consumers deduplicate (record_id,
content_hash), retain different hashes as versions, and review missing sources.
"""
import argparse
import datetime as dt
import hashlib
import json
from pathlib import Path
import re
import sys

sys.dont_write_bytecode = True
BASE = Path(__file__).resolve().parents[1]
ROOT = BASE / 'runtime/native_dsh/home/sessions'
COUNTERS = ('inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens',
            'reasoningTokens', 'totalTokens')
SECRET = re.compile(r'(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|'
                    r'github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.|'
                    r'(?i:api[_ -]?key|password|cookie|secret)\s*[:=]\s*\S{8,})')
PRIVATE = re.compile(r'(?i:visibility["\s]*[:=]["\s]*(?:closed|private)|closed/private)')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(canonical(value).encode('utf-8')).hexdigest()


def timestamp(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
        return dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc).isoformat()
    if isinstance(value, str):
        try:
            t = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
            return t.astimezone(dt.timezone.utc).isoformat() if t.tzinfo else None
        except ValueError:
            pass
    return None


def project(path, rows, observed):
    header = rows[0]
    if header.get('type') != 'session' or not isinstance(header.get('id'), str):
        raise ValueError('Expected native session header: ' + str(path))
    sid = header['id']
    calls = {}
    for line, event in enumerate(rows[1:], 2):
        kind, data = event.get('type'), event.get('data', {})
        content = None
        role = 'metadata'
        identity = str(event.get('seq', line - 2))
        if kind in ('user/message', 'assistant/message'):
            message = data.get('message', data)
            source = message.get('source', {})
            if kind == 'user/message' and source.get('kind') != 'user':
                continue  # AGENTS/context injections are not human messages.
            role = message.get('role', kind.split('/')[0])
            identity = str(message.get('id', identity))
            blocks = message.get('content', [])
            visible = [x['text'] for x in blocks if x.get('type') == 'text' and isinstance(x.get('text'), str)]
            content = {'text_blocks': visible, 'producer_kind': source.get('kind'),
                       'interrupted': data.get('interrupted', False)}
            usage = data.get('usage', {})
            if usage:
                content['usage'] = {k: usage[k] for k in COUNTERS if isinstance(usage.get(k), (int, float))}
        elif kind == 'tool/call':
            identity = str(data.get('callId', identity))
            calls[identity] = data.get('name')
            content = {'call_id': identity, 'tool_name': data.get('name'),
                       'arguments_hash': digest(data.get('arguments'))}
        elif kind == 'tool/result':
            message = data.get('message', {})
            identity = str(message.get('toolCallId', identity))
            content = {'call_id': identity, 'tool_name': calls.get(identity),
                       'is_error': bool(message.get('isError', False)),
                       'result_hash': digest(message.get('content'))}
        if content is None:
            continue  # No streams, hidden reasoning, system prompts or tool bodies.
        raw_hash = digest(content)
        if SECRET.search(canonical(content)) or PRIVATE.search(canonical(content)):
            content = {'event_kind': 'sensitive_local_review', 'withheld_content_hash': raw_hash}
            role = 'metadata'
        rid = 'dsh:' + sid + ':' + kind + ':' + identity
        chash = digest(content)
        yield {'schema_version': 1, 'source': 'persona.native_dsh', 'record_id': rid,
               'conversation_id': sid, 'role': role, 'event_type': kind,
               'occurred_at': timestamp(event.get('time')), 'observed_at': observed,
               'content': content, 'content_hash': chash, 'version_id': digest([rid, chash]),
               'original_location': {'path': str(path), 'line': line, 'seq': event.get('seq'),
                                     'raw_line_hash': digest(event)},
               'review_status': 'local_only_not_authorized_for_sharing'}


def collect(root):
    observed = dt.datetime.now(dt.timezone.utc).isoformat()
    candidates = {}
    if root.exists():
        for path in root.rglob('*.jsonl'):
            match = re.fullmatch(r'(?:session(?:\.v(\d+))?|generation(?:\.(\d+))?)\.jsonl', path.name)
            if not match:
                continue
            # Native selects its highest format generation. Preserve older files
            # locally, but do not count migrated copies as additional conversations.
            version = int(match.group(1) or match.group(2) or 0)
            previous = candidates.get(path.parent)
            if previous is None or version > previous[0]:
                candidates[path.parent] = (version, path)
    records, coverage = [], []
    for _, path in sorted(candidates.values(), key=lambda x: str(x[1])):
        raw = path.read_bytes()
        rows = [json.loads(line) for line in raw.decode('utf-8').splitlines() if line.strip()]
        if not rows:
            raise ValueError('Empty native session: ' + str(path))
        projected = list(project(path, rows, observed))
        records.extend(projected)
        coverage.append({'path': str(path), 'session_id': rows[0].get('id'), 'raw_lines': len(rows),
                         'visible_records': len(projected), 'sha256': hashlib.sha256(raw).hexdigest()})
    ids = [r['record_id'] for r in records]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate native identities; investigate lineage before export')
    return records, coverage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--summary', action='store_true', help='Only counts/hashes, no message content')
    parser.add_argument('--verify', action='store_true', help='Read twice and verify unchanged version identities')
    args = parser.parse_args()
    records, coverage = collect(ROOT)
    result = {'local_records': len(records), 'sources': coverage, 'source_root_exists': ROOT.exists(),
              'github_published': False, 'dots_read_verified': False,
              'missing_source_policy': 'review_needed; absence does not delete saved evidence'}
    if args.verify:
        again, second = collect(ROOT)
        result['repeat_no_duplicate_versions'] = [r['version_id'] for r in records] == [r['version_id'] for r in again]
        result['sources_unchanged_during_check'] = coverage == second
        if not result['repeat_no_duplicate_versions'] or not result['sources_unchanged_during_check']:
            raise SystemExit('Native source changed during verification; retry after turn finishes')
    if args.summary or args.verify:
        print(canonical(result))
    else:
        for record in records:
            print(canonical(record))


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    main()
