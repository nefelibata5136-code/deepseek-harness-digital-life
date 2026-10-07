"""Read native public capability receipts. No reasoning, Vault, or credential output."""
from pathlib import Path
import datetime as dt
import json

base = Path(__file__).resolve().parents[2]
sid = '80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b'
path = next((base / 'runtime/native_dsh/home/sessions').glob(f'*/{sid}/session.v4.jsonl'))
rows = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]
assert rows[0]['id'] == sid
calls, receipts, failed = {}, [], []
for line, e in enumerate(rows, 1):
    if e.get('seq', -1) < 1978:
        continue
    d = e.get('data', {})
    if e.get('type') == 'tool/call' and d.get('name', '').startswith('cap__bluesky__'):
        calls[d['callId']] = {'name': d['name'], 'callSeq': e['seq'], 'callLine': line,
                              'arguments': json.loads(d['arguments']), 'callId': d['callId']}
    if e.get('type') != 'tool/result':
        continue
    m = d.get('message', {})
    call = calls.get(m.get('toolCallId'))
    if not call:
        continue
    text = '\n'.join(b.get('text', '') for b in m.get('content', []) if b.get('type') == 'text')
    try:
        value = json.loads(text)
    except ValueError:
        value = {'error': 'native_tool_error', 'detail': text}
    r = {**call, 'resultSeq': e['seq'], 'resultLine': line, 'value': value}
    if m.get('isError') or value.get('error') or value.get('ok') is False:
        failed.append({'name': call['name'], 'callSeq': call['callSeq'], 'resultSeq': e['seq'], 'error': value.get('error')})
    else:
        receipts.append(r)

def named(suffix):
    return [r for r in receipts if r['name'] == 'cap__bluesky__bluesky_' + suffix]

def posts_in_thread(t):
    if not t:
        return []
    result = [t['post']] if t.get('post') else []
    result += posts_in_thread(t.get('parent'))
    for reply in t.get('replies', []):
        result += posts_in_thread(reply)
    return result

batches = [{'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'], 'directions': r['arguments'].get('directions', []),
            'candidateCount': len(r['value'].get('candidates', [])),
            'candidateUris': [p['uri'] for p in r['value'].get('candidates', [])],
            'pages': [{k: v for k, v in p.items() if k != 'cursor'} for p in r['value'].get('pages', [])]} for r in named('explore')]
discovered = {uri for b in batches for uri in b['candidateUris']}
deep = [{'uri': r['arguments']['uri'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'],
         'selectedFromDiscovery': r['arguments']['uri'] in discovered,
         'postsRead': len(posts_in_thread(r['value'].get('thread')))} for r in named('thread')]
published = {}
for r in named('post'):
    v = r['value']
    if v.get('repositoryVerified'):
        published.setdefault(v['uri'], {'uri': v['uri'], 'url': v['url'], 'cid': v['cid'], 'record': v['record'],
            'draftId': r['arguments']['draft_id'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq']})
parents = [p for p in published.values() if not p['record'].get('reply')]
comments = [p for p in published.values() if p['record'].get('reply')]
read_uris = {p.get('uri') for r in named('thread') for p in posts_in_thread(r['value'].get('thread'))}
own_repository_uris = {p['uri'] for r in named('own_posts') for p in r['value'].get('repositoryRecords', [])}
avatars = [r for r in named('avatar_set') if r['value'].get('verified')]
images = [e for e in rows if e.get('seq', -1) >= 1978 and e.get('type') == 'tool/result'
          and any(b.get('type') == 'image' for b in e.get('data', {}).get('message', {}).get('content', []))]
functions = sorted({r['name'].split('bluesky_', 1)[1] for r in receipts})
checks = {
    'realConsciousnessSeat': rows[0]['id'] == sid,
    'agentChosenQueries': any(len(b['directions']) >= 2 and b['candidateCount'] >= 8 for b in batches),
    'realBatchReturned': any(b['candidateCount'] >= 8 for b in batches),
    'agentSelectedAndDeepRead': any(r['selectedFromDiscovery'] and r['postsRead'] >= 1 for r in deep),
    'oneOriginalPost': len(parents) == 1,
    'oneRealComment': len(comments) == 1,
    'commentParentAndRootCorrect': len(parents) == len(comments) == 1 and all(
        comments[0]['record']['reply'][k]['uri'] == parents[0]['uri'] for k in ['parent', 'root']),
    'allPublishedReadThroughOwnPosts': bool(published) and set(published) <= own_repository_uris,
    'allPublishedPublicThreadRead': bool(published) and set(published) <= read_uris,
    'notificationsActuallyRead': bool(named('notifications')),
    'authorActuallyRead': bool(named('author')),
    'feedCatalogActuallyRead': bool(named('feed_catalog')),
    'profileActuallyUpdatedAndRead': any(r['value'].get('verified') for r in named('profile_update')) and bool(named('status')),
    'avatarActuallyViewedAndSet': bool(avatars) and bool(images),
}
result = {'passed': all(checks.values()), 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
          'sessionId': sid, 'nativeSource': str(path), 'latestSeq': rows[-1].get('seq'), 'checks': checks,
          'functionsSuccessfullyUsedByPersona': functions, 'batches': batches, 'deepReads': deep,
          'published': list(published.values()), 'avatar': avatars[-1]['value'] if avatars else None,
          'initialFailuresPreserved': failed,
          'evidence': [{'name': r['name'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'],
                        'callLine': r['callLine'], 'resultLine': r['resultLine']} for r in receipts],
          'scope': 'Only named public Bluesky receipts from the real main Session; no hidden reasoning or private data.'}
reports = base / 'reports/bluesky'
reports.mkdir(exist_ok=True)
(reports / 'acceptance.json').write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'passed': result['passed'], 'latestSeq': result['latestSeq'], 'checks': checks,
                  'published': [{'url': p['url'], 'draftId': p['draftId']} for p in published.values()],
                  'avatar': result['avatar']}, ensure_ascii=False))
