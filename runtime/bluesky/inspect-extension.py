"""Audit actual native public tool receipts; never export reasoning or credentials."""
from pathlib import Path
import json
import datetime as dt

base = Path(__file__).resolve().parents[2]
sid = '80c2ef0d-35d8-5ad6-9a7b-f12403a0db1b'
sessions = base / 'runtime/native_dsh/home/sessions'
first_seq = 2740

def load(identity):
    path = next(sessions.glob(f'*/{identity}/session.v4.jsonl'))
    return path, [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]

def receipts(rows, minimum=0):
    calls, result = {}, []
    for line, event in enumerate(rows, 1):
        if event.get('seq', -1) < minimum:
            continue
        data = event.get('data', {})
        if event.get('type') == 'tool/call':
            try:
                args = json.loads(data.get('arguments', '{}'))
            except ValueError:
                args = {}
            calls[data['callId']] = {'name': data['name'], 'args': args, 'callSeq': event['seq'], 'callLine': line, 'callTime': event.get('time')}
        if event.get('type') != 'tool/result':
            continue
        message = data.get('message', {})
        call = calls.get(message.get('toolCallId'))
        if not call:
            continue
        blocks = message.get('content', [])
        text = '\n'.join(block.get('text', '') for block in blocks if block.get('type') == 'text')
        try:
            value = json.loads(text)
        except ValueError:
            value = {'text': text}
        result.append({**call, 'resultSeq': event['seq'], 'resultLine': line, 'resultTime': event.get('time'), 'value': value,
                       'failed': bool(message.get('isError') or isinstance(value, dict) and (value.get('error') or value.get('ok') is False)
                                      or text.lstrip().startswith('Error:')),
                       'hasImage': any(block.get('type') == 'image' for block in blocks),
                       'imageAttachments': [block.get('attachment') for block in blocks if block.get('type') == 'image' and block.get('attachment')]})
    return result

path, rows = load(sid)
parent = receipts(rows, first_seq)
named = lambda suffix: [r for r in parent if r['name'] == 'cap__bluesky__bluesky_' + suffix and not r['failed']]
children = []
for candidate in sessions.glob('*/ */session.v4.jsonl'.replace(' ', '')):
    try:
        header = json.loads(candidate.open(encoding='utf-8').readline())
    except (OSError, ValueError):
        continue
    if header.get('parentSession') != sid or header.get('origin') != 'subagent':
        continue
    child_rows = [json.loads(line) for line in candidate.read_text(encoding='utf-8').splitlines() if line.strip()]
    read = receipts(child_rows)
    batches = [r for r in read if r['name'].endswith('__bluesky_batch_preview') and not r['failed'] and r['value'].get('total', 0) > 0]
    if not batches:
        continue
    children.append({'sessionId': header['id'], 'source': str(candidate), 'receipts': read, 'batches': batches,
                     'summaryDelivered': any(r['name'] == 'send_message' and r['args'].get('agent_id') == sid and not r['failed'] for r in read)})

opened = named('open_preview')
child_batches = {r['value']['batch_id']: r for child in children for r in child['batches']}
stable = [r for r in opened if r['args'].get('batch_id') in child_batches and
          r['value'].get('snapshot', {}).get('uri') == next((p['uri'] for p in child_batches[r['args']['batch_id']]['value']['candidates'] if p['number'] == r['args']['number']), None)]

def thread_posts(value):
    tree = value.get('thread')
    def collect(node):
        if not node:
            return []
        return ([node['post']] if node.get('post') else []) + collect(node.get('parent')) + [p for item in node.get('replies', []) for p in collect(item)]
    # `replies` is the public reply index view, while tree/snapshot use nodes.
    # All variants still have to satisfy exact URI/CID/text/author readback below.
    return collect(tree) + value.get('posts', []) + [item['value']['post'] for item in value.get('items', []) if item.get('value', {}).get('post')]

published = [r for r in named('post') if r['value'].get('repositoryVerified') and
             r['args'].get('draft_id', '').startswith('persona-bluesky-extension-')]
posts = {r['value']['uri']: r for r in published if not r['value'].get('record', {}).get('reply')}
replies = {r['value']['uri']: r for r in published if r['value'].get('record', {}).get('reply')}
thread_records = {p['uri']: p for r in named('thread') for p in thread_posts(r['value']) if p.get('uri')}
thread_uris = set(thread_records)
own_records = {p['uri']: p for r in named('own_posts') for p in r['value'].get('repositoryRecords', [])}
own_uris = set(own_records)
bookmark_targets = {r['args']['uri'] for r in named('bookmark_action') if r['args'].get('action') == 'create' and r['value'].get('verified')}
bookmarked = {item.get('subject', {}).get('uri') for r in named('bookmarks_list') for item in r['value'].get('bookmarks', [])}
stable_cids = {r['value']['snapshot']['uri']: r['value']['snapshot'].get('cid') for r in stable}
def recovered_bookmark(receipt):
    # The old decoder failed AFTER a real empty-output success. Prove the state
    # change with an earlier absent list and a later matching strong reference,
    # including the server creation timestamp inside this actual native call.
    if receipt['args'].get('action') != 'create' or receipt['value'].get('error') != 'BLUESKY_NON_JSON_RESPONSE' or receipt['value'].get('status') != 200:
        return False
    target = receipt['args'].get('uri')
    before = any(r['resultSeq'] < receipt['callSeq'] and not any(b.get('subject', {}).get('uri') == target for b in r['value'].get('bookmarks', [])) for r in named('bookmarks_list'))
    for read in named('bookmarks_list'):
        if read['callSeq'] <= receipt['resultSeq']:
            continue
        for item in read['value'].get('bookmarks', []):
            try:
                created = dt.datetime.fromisoformat(item.get('createdAt', '').replace('Z', '+00:00')).timestamp() * 1000
            except (ValueError, TypeError):
                continue
            if before and item.get('subject', {}).get('uri') == target and item.get('subject', {}).get('cid') == stable_cids.get(target) and receipt['callTime'] <= created <= receipt['resultTime']:
                return True
    return False
recovered_bookmarks = [r for r in parent if r['name'] == 'cap__bluesky__bluesky_bookmark_action' and recovered_bookmark(r)]
bookmark_targets.update(r['args']['uri'] for r in recovered_bookmarks)
media = [r for r in named('media') if r['value'].get('images') or r['value'].get('video')]
navigated = [r for r in parent if ('navigate' in r['name'] or 'launch_app' in r['name']) and not r['failed'] and any(
    any(url and url in str(r['args']) for url in (item['value'].get('browser_gallery'), item['value'].get('gallery_file'), item['value'].get('post_url')))
    for item in media)]
visual = [r for r in parent if r['hasImage'] and not r['failed'] and 'screenshot' in r['name'] and navigated
          and r['callSeq'] > min(n['callSeq'] for n in navigated)]
custom = [r for r in named('feed_read') if r['args'].get('kind') == 'custom' and r['value'].get('posts')]
peer_did = 'did:plc:example'
notifications = [n for r in named('notifications') for n in r['value'].get('notifications', []) if n.get('author', {}).get('did') == peer_did and n.get('reasonSubject') in posts]
dm_sent = [r for r in named('chat_send') if r['args'].get('action') == 'send' and r['value'].get('verified')
           and r['args'].get('draft_id') == 'persona-bluesky-controlled-dm-reply-20261005']
dm_verified = [sent for sent in dm_sent if any(
    read['args'].get('conversation_id') == sent['value'].get('conversationId') and read['callSeq'] < sent['callSeq']
    and any(m.get('sender', {}).get('did') == peer_did for m in read['value'].get('messages', []))
    for read in named('chat_read')) and any(
    read['args'].get('conversation_id') == sent['value'].get('conversationId') and read['callSeq'] > sent['resultSeq']
    and any(m.get('id') == sent['value'].get('message', {}).get('id') and
            m.get('text') == sent['value'].get('message', {}).get('text') and
            m.get('sender', {}).get('did') == 'did:plc:example'
            for m in read['value'].get('messages', [])) for read in named('chat_read'))]
jetstream = [r for r in named('stream') if r['value'].get('connected') and r['value'].get('events') and any(r['value'].get('filters', {}).get(k) for k in ('collections', 'authors', 'keywords'))]
avatar_navigation = [r for r in parent if 'navigate' in r['name'] and not r['failed'] and any(
    catalog['value'].get('browser_gallery') and catalog['value']['browser_gallery'] in str(r['args']) for catalog in named('avatar_catalog'))]
avatar_screens = [r for r in parent if r['hasImage'] and not r['failed'] and 'screenshot' in r['name'] and any(n['resultSeq'] < r['callSeq'] for n in avatar_navigation)]
avatar_choices = [r for r in named('avatar_set') if r['value'].get('verified') and any(s['resultSeq'] < r['callSeq'] for s in avatar_screens)]
source_reads = [r for r in parent if r['name'] in ('read', 'read_source') and not r['failed'] and
                'versions/2.1.2/' in str(r['args'].get('file_path', '')).replace('\\', '/') and
                str(r['args'].get('file_path', '')).endswith(('README.md', 'SOURCE.json'))]
source_checks = [r for r in parent if r['name'] == 'terminal' and not r['failed'] and
                 '2.1.2' in str(r['args']) and 'verify.mjs' in str(r['args']) and
                 any(r['value'].get(key) == 0 for key in ('returncode', 'exit_code', 'exitCode', 'code'))]
safety_add = [r for r in named('safety_update') if r['args'].get('kind') == 'muted_word' and r['args'].get('action') == 'add' and r['value'].get('verified')]
safety_remove = [r for r in named('safety_update') if r['args'].get('kind') == 'muted_word' and r['args'].get('action') == 'remove' and r['value'].get('verified')]
checks = {
    'A_contentDiscovery': bool(custom or named('search') or named('explore')),
    'B_realGeneralSubagentSummaryAndExactOpen': bool(stable and any(c['summaryDelivered'] for c in children)),
    'C_selectedPostAndThread': any(r['value'].get('snapshot', {}).get('uri') in thread_uris for r in stable),
    'D_profileAuthorAndSocialGraph': bool(named('people') and named('author') and named('social_read')),
    'E_customFeedDiscoveredAndRead': bool(custom and named('feed_discover')),
    'F_mediaActuallyEnteredVisualChain': bool(media and navigated and visual),
    'G_privateBookmarkCreatedAndListed': bool(bookmark_targets & bookmarked),
    'H_likeOrFollowVerified': any(r['args'].get('action') in ('like', 'follow') and r['value'].get('verified') for r in named('social_action')),
    'I_oneAgentWrittenExtensionPost': len(posts) == 1,
    'J_selfThreadReplyVerified': len(posts) == len(replies) == 1 and all(
        r['value']['record']['reply'][key]['uri'] in posts for r in replies.values() for key in ('parent', 'root')),
    'K_notificationsRead': bool(named('notifications')),
    'K_controlledRealNotificationReceived': bool(notifications),
    'L_controlledDMReceivedAndReplyReadback': bool(dm_verified),
    'M_realFilteredJetstreamEvents': bool(jetstream),
    'N_mutedWordAddedVerifiedAndRemoved': any(a['args']['word'] == r['args']['word'] for a in safety_add for r in safety_remove),
    'O_ownPostAndReplyRepositoryAndPublicReadback': bool(posts and replies and all(
        own_records.get(uri, {}).get('cid') == receipt['value']['cid'] and
        own_records.get(uri, {}).get('value') == receipt['value']['record'] and
        thread_records.get(uri, {}).get('cid') == receipt['value']['cid'] and
        thread_records.get(uri, {}).get('text') == receipt['value']['record']['text'] and
        thread_records.get(uri, {}).get('author', {}).get('did') == 'did:plc:example'
        for uri, receipt in {**posts, **replies}.items())),
    'threadSnapshotPageBeyond30ByRealAgent': any(r['args'].get('mode') == 'snapshot' and r['value'].get('offset', 0) >= 30 and r['value'].get('items') for r in named('thread')),
}
result = {'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'sessionId': sid, 'firstSeq': first_seq,
          'nativeSource': str(path), 'latestSeq': rows[-1].get('seq'), 'passed': all(checks.values()), 'checks': checks,
          'childBatches': [{'sessionId': c['sessionId'], 'source': c['source'], 'summaryDelivered': c['summaryDelivered'],
                           'batches': [{'batch_id': r['value']['batch_id'], 'directions': len(r['value'].get('pages', [])),
                                        'total': r['value'].get('total'), 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq']} for r in c['batches']]} for c in children],
          'published': [{'uri': r['value']['uri'], 'cid': r['value']['cid'], 'url': r['value']['url'], 'draft_id': r['args']['draft_id'],
                         'callSeq': r['callSeq'], 'resultSeq': r['resultSeq']} for r in list(posts.values()) + list(replies.values())],
          'visualEvidence': [{'name': r['name'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'],
                              'attachments': r['imageAttachments']} for r in visual],
          'avatarEvidence': [{'number': r['value']['number'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'],
                              'blobCid': r['value'].get('blobCid'), 'originalPreserved': r['value'].get('originalPreserved'),
                              'screenshotSeqs': [s['resultSeq'] for s in avatar_screens if s['resultSeq'] < r['callSeq']],
                              'publicProfileReadbackSeqs': [s['resultSeq'] for s in named('status') if s['callSeq'] > r['resultSeq'] and
                                  r['value'].get('blobCid', '!missing') in str(s['value'].get('account', {}).get('avatar', ''))]}
                             for r in avatar_choices],
          'maintenanceEvidence': {'sourceReadSeqs': [r['resultSeq'] for r in source_reads],
                                  'cheapCheckSeqs': [r['resultSeq'] for r in source_checks]},
          'recoveredBookmarkEvidence': [{'createCallSeq': r['callSeq'], 'originalFailureSeq': r['resultSeq'],
                                          'uri': r['args']['uri'], 'proof': 'earlier absence, later exact URI/CID and server creation time inside the native write call'} for r in recovered_bookmarks],
          'evidence': [{'name': r['name'], 'callSeq': r['callSeq'], 'resultSeq': r['resultSeq'], 'callLine': r['callLine'], 'resultLine': r['resultLine'], 'failed': r['failed']}
                       for r in parent if r['name'].startswith('cap__bluesky__') or r in navigated or r in visual or r['name'] == 'subagent'],
          'scope': 'Actual native calls and returns; no hidden reasoning, Vault, credential values or private message bodies exported.'}
result['deliveryPassed'] = result['passed'] and any(r['publicProfileReadbackSeqs'] for r in result['avatarEvidence']) and \
    len({str(r['args']['file_path']).replace('\\', '/').rsplit('/', 1)[-1] for r in source_reads}) == 2 and bool(source_checks)
(base / 'reports/bluesky/extension-acceptance.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'passed': result['passed'], 'latestSeq': result['latestSeq'], 'checks': checks, 'childBatches': result['childBatches'], 'published': result['published']}, ensure_ascii=False))
