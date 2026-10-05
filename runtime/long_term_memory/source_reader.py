"""Raw chat adapters. No event segmentation, normalization, or hidden reasoning."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import os
from datetime import datetime,timezone

def compact(value):return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))
def digest(value):return hashlib.sha256(value if isinstance(value,bytes) else value.encode('utf-8')).hexdigest()
def message_key(namespace,conversation,record_id):return compact([namespace,str(conversation),str(record_id)])

class SourceConflict(ValueError):
    def __init__(self,pairs):
        self.pairs=pairs
        super().__init__('Conflicting raw records within a namespace; originals preserved. Open source_conflicts to read both versions. Keys: '+compact([p['mid'] for p in pairs]))
def read_lines(path, native=False):
    data=path.read_bytes()
    if native:data=data[:data.rfind(b'\n')+1]
    return [(n,json.loads(line)) for n,line in enumerate(data.decode('utf-8-sig').splitlines(),1) if line.strip()]

def snapshot(base,config):
    messages={}
    conflicts=[]
    def add(namespace,record,path,line,kind):
        key=message_key(namespace,record['conversation_id'],record['id'])
        raw=compact(record)
        locator={'path':str(path),'line':line,'record_id':record['id'],'source_kind':kind}
        item={'mid':key,'namespace':namespace,'conversation':str(record['conversation_id']),
              'record_id':str(record['id']),'raw':record,'revision_hash':digest(raw),
              'content_hash':digest(str(record.get('content',''))),'locators':[locator]}
        if key in messages:
            if messages[key]['revision_hash']!=item['revision_hash']:
                conflicts.append({'mid':key,'sources':[messages[key],item],'kind':'same_namespace_conflict'})
            else:messages[key]['locators'].append(locator)
        else:messages[key]=item
    for source in config['sources']:
        path=base/source['path']
        for line,row in read_lines(path):
            if not all(k in row for k in ('id','conversation_id','role','content')):raise ValueError('Invalid raw record at '+str(path)+':'+str(line))
            add(source['namespace'],row,path,line,'raw_chat')
    # Selected excerpts are locators, never an independent source that can keep
    # a deleted/currently changed canonical message alive.
    selections=base/config.get('selection_locators','history/selected_original_records')
    if selections.exists():
        for path in selections.glob('*.jsonl'):
            for line,row in read_lines(path):
                if not all(k in row for k in ('id','conversation_id','role','content')):continue
                key=message_key('local_runtime',row['conversation_id'],row['id'])
                if key in messages and digest(compact(row))==messages[key]['revision_hash']:
                    locator={'path':str(path),'line':line,'record_id':row['id'],'source_kind':'selected_excerpt'}
                    if locator not in messages[key]['locators']:messages[key]['locators'].append(locator)
    sessions=Path(config.get('native_sessions', str(Path(os.environ.get('DL_DATA', str(base/'.local')))/'dsh-home/sessions')))
    workspace=Path(config['workspace']).resolve()
    if sessions.exists():
        for path in sessions.glob('*/*/session.v4.jsonl'):
            records=read_lines(path,native=True)
            if not records:continue
            header=records[0][1]
            if header.get('type')!='session' or header.get('version')!=4 or Path(header.get('cwd','')).resolve()!=workspace:continue
            # Independent intention expansions are technical drafts, not eight
            # extra lives or ordinary activity conversations. Keep their native
            # logs for audit; explicit memory sync must not promote their prompts
            # or intermediate prose into the raw autobiographical source pool.
            if any(event.get('type')=='subagent/descriptor' and event.get('data',{}).get('provider')=='persona-intention'
                   for _,event in records[1:]):continue
            namespace='harness_session_v4'
            sid=header['id']
            for line,event in records[1:]:
                data=event.get('data',{})
                timestamp=datetime.fromtimestamp(event['time']/1000,timezone.utc).isoformat() if event.get('time') else None
                if event['type']=='agent/inbox/spliced':
                    for i,m in enumerate(data.get('inserted',[])):
                        source=m.get('source',{}).get('kind')
                        if m.get('role')!='user' or source not in ('user','schedule'):continue
                        content='\n'.join(b['text'] for b in m.get('content',[]) if b.get('type')=='text')
                        if content:add(namespace,{'id':f"{event['seq']}:user:{i}",'conversation_id':sid,'role':'user','content':content,'created_at':timestamp,'source':source,'delegation_depth':header.get('delegationDepth',0)},path,line,'native_text')
                elif event['type']=='assistant/message':
                    content='\n'.join(b['text'] for b in data.get('message',{}).get('content',[]) if b.get('type')=='text')
                    if content:add(namespace,{'id':f"{event['seq']}:assistant",'conversation_id':sid,'role':'assistant','content':content,'created_at':timestamp,'delegation_depth':header.get('delegationDepth',0)},path,line,'native_text')
    if conflicts:raise SourceConflict(conflicts)
    return messages

def verify_current(item):
    """Resolve IDs against the current source, not a cached line number."""
    for locator in item['locators']:
        path=Path(locator['path'])
        native=locator['source_kind']=='native_text'
        if native:
            # For native text, validate the event sequence and content through
            # the same adapter on sync; the original log remains an exit.
            return {'path':str(path),'line':locator['line'],'revision_hash':item['revision_hash'],'source_kind':locator['source_kind']}
        for line,row in read_lines(path):
            if str(row.get('id'))==item['record_id'] and str(row.get('conversation_id'))==item['conversation']:
                if digest(compact(row))!=item['revision_hash']:continue
                return {**locator,'line':line,'revision_hash':item['revision_hash']}
    raise ValueError('Current source differs or missing; run sync and review, do not display stale source as current')

def anchor_span(content,start,end=None):
    if not start and not end:raise ValueError('An exact semantic anchor is required')
    positions=[]
    offset=0
    while start:
        pos=content.find(start,offset)
        if pos<0:break
        positions.append(pos);offset=pos+1
    if start and len(positions)!=1:raise ValueError('Anchor missing or ambiguous; no guessed offset: '+start)
    begin=positions[0] if start else 0
    if end:
        endings=[];offset=begin+len(start or '')
        while True:
            pos=content.find(end,offset)
            if pos<0:break
            endings.append(pos);offset=pos+1
        if len(endings)!=1:raise ValueError('End anchor missing or ambiguous; no guessed offset: '+end)
        finish=endings[0]+len(end)
    else:finish=len(content)
    return {'start':begin,'end':finish,'exact_quote':content[begin:finish],
            'start_anchor':start,'end_anchor':end,'content_hash':digest(content),
            'offset_unit':'Unicode code points; not JavaScript UTF-16 offsets'}

def resolve_actor(base,call_id=None,authored_file=None):
    """Bind writes to a persisted native receipt rather than a model actor claim."""
    if not call_id and not authored_file:raise PermissionError('A native tool-call or authored-file receipt is required')
    content=Path(authored_file).read_text('utf-8') if authored_file else None
    matches=[]
    for path in (Path(os.environ.get('DL_DATA', str(base/'.local')))/'dsh-home/sessions').glob('*/*/session.v4.jsonl'):
        records=read_lines(path,native=True)
        if not records:continue
        header=records[0][1]
        if Path(header.get('cwd','')).resolve()!=Path(os.environ.get('DL_WORKSPACE', '.local/workspace')).resolve():continue
        reconstructed=None;file_receipts=[];last_file_event=None
        successful={e['data'].get('message',{}).get('toolCallId') for _,e in records if e['type']=='tool/result' and not e['data'].get('message',{}).get('isError')}
        for _,event in records[1:]:
            if event['type']!='tool/call':continue
            d=event['data']
            if call_id and d.get('callId')==call_id:matches.append((header,event,path))
            elif authored_file and d.get('name') in ('write','edit'):
                try:args=json.loads(d['arguments'])
                except (KeyError,ValueError):continue
                if Path(args.get('file_path','')).resolve()!=Path(authored_file).resolve() or d.get('callId') not in successful:continue
                if d['name']=='write':reconstructed=args.get('content');file_receipts=[]
                elif reconstructed is not None:
                    old=args.get('old_string');new=args.get('new_string')
                    if not isinstance(old,str) or not isinstance(new,str) or old not in reconstructed:reconstructed=None;continue
                    if not args.get('replace_all') and reconstructed.count(old)!=1:reconstructed=None;continue
                    reconstructed=reconstructed.replace(old,new,-1 if args.get('replace_all') else 1)
                file_receipts.append({'call_id':d['callId'],'seq':event['seq'],'operation':d['name']});last_file_event=event
        if authored_file and reconstructed==content and last_file_event:
            matches.append((header,{**last_file_event,'file_receipts':file_receipts},path))
    if len(matches)!=1:raise PermissionError('Native author receipt missing/ambiguous; no self-declared authorship accepted')
    h,e,p=matches[0]
    return {'kind':'persona' if h.get('delegationDepth',0)==0 else 'child_suggestion',
            'session_id':h['id'],'call_id':e['data']['callId'],'seq':e['seq'],
            'recorded_at':datetime.fromtimestamp(e['time']/1000,timezone.utc).isoformat(),'native_path':str(p),
            **({'file_receipts':e['file_receipts']} if e.get('file_receipts') else {})}
