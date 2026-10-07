"""Host-only adapter for the existing Memory engine. No ambient owner or key fallback.

The JavaScript factory authenticates execution object identity and native owners.
This single-operation subprocess receives an immutable owner/binding envelope on
stdin, then rechecks the exact persisted tool receipt for authored mutations.
"""
from __future__ import annotations
import json
import math
import os
import sys
import tempfile
from pathlib import Path
from datetime import datetime, timezone


def main():
    request=json.loads(sys.stdin.read(2*1024*1024+1))
    sys.path.insert(0,request['engineRoot'])
    import engine
    from engine import Memory,atomic_json,now
    from source_reader import snapshot,compact,read_lines
    from cli import operation

    owner=request['owner'];binding=request['binding'];sessions=request['sessions']
    store=Path(binding['store']);store.mkdir(parents=True,exist_ok=True)

    def scoped_snapshot(base,unused_config):
        # Reuse the existing raw/native adapters without letting their default
        # glob discover another owner's Sessions. A transient view contains only
        # Host-selected owned files; locators are restored to the actual source.
        with tempfile.TemporaryDirectory(prefix='.owned-native-view-',dir=store) as directory:
            view=Path(directory);paths={};peer_rows=[];peer_locations={}
            for i,item in enumerate(sessions):
                original=Path(item['path']);data=original.read_bytes()
                first=data.split(b'\n',1)[0].decode('utf-8-sig')
                if json.loads(first)!=item['header']:raise PermissionError('MEMORY_NATIVE_IDENTITY_CHANGED')
                target=view/str(i)/item['sessionId']/'session.v4.jsonl'
                target.parent.mkdir(parents=True);target.write_bytes(data)
                paths[str(target)]=str(original)
                records=read_lines(original,native=True);seen_peer_ids=set()
                for line,event in records[1:]:
                    if event.get('type')!='agent/inbox/spliced':continue
                    for index,message in enumerate(event.get('data',{}).get('inserted',[])):
                        source=message.get('source',{})
                        if source.get('kind') not in ('life-message','room-inbox'):continue
                        seen_peer_ids.add(peer_key(source))
                        add_peer(peer_rows,peer_locations,item,line,event,message,f"{event['seq']}:user:{index}")
                for line,event in records[1:]:
                    message=event.get('data',{});source=message.get('source',{})
                    if event.get('type')=='user/message' and source.get('kind') in ('life-message','room-inbox') and peer_key(source) not in seen_peer_ids:
                        add_peer(peer_rows,peer_locations,item,line,event,message,f"{event['seq']}:peer")
            peer_path=view/'peer-records.jsonl'
            peer_path.write_text(''.join(compact(row)+'\n' for row in peer_rows),encoding='utf-8')
            config={'sources':binding['sources'],'workspace':binding['workspace'],
                    'native_sessions':str(view),'selection_locators':str(view/'disabled-selected-excerpts')}
            if peer_rows:config['sources']=[*config['sources'],{'namespace':'harness_session_v4','path':str(peer_path)}]
            current=snapshot(base,config)
            for item in current.values():
                for locator in item['locators']:
                    if locator['source_kind']=='native_text':locator['path']=paths[locator['path']]
                    elif locator['path']==str(peer_path):
                        original,line=peer_locations[(item['conversation'],item['record_id'])]
                        locator.update(path=original,line=line,source_kind='native_text')
            return current

    def peer_key(source):
        # Message ids belong to rooms, rather than a global conversation. Only
        # deduplicate materialized/inbox views of the same attributed envelope.
        return (source.get('kind'),source.get('roomId',source.get('conversationId')),
                source.get('messageId',source.get('rpcId')),source.get('senderPrincipalId'))

    def peer_sender(source):
        # Native 'user' is a transport role. Speaker identity comes exclusively
        # from the Host's persisted principal mapping, never from that role,
        # message body, recipient identity, or a presumed human name.
        principal=source.get('senderPrincipalId');sender=source.get('sender')
        if sender is not None:
            if not isinstance(sender,dict) or sender.get('sender_id')!=principal or sender.get('sender_type') not in ('life','human','unknown'):
                raise PermissionError('MEMORY_PEER_SENDER_MISMATCH')
            if sender['sender_type']=='life' and sender.get('life_id')!=principal or sender['sender_type']!='life' and sender.get('life_id') is not None:
                raise PermissionError('MEMORY_PEER_SENDER_MISMATCH')
            return sender
        # Compatibility with the former life-message envelope, whose principal
        # was explicit but had no display-name/type object. Unknown stays unknown.
        kind='life' if isinstance(principal,str) and principal.startswith('life-') else 'human' if isinstance(principal,str) and principal.startswith('human:') else 'unknown'
        return {'sender_id':principal,'sender_type':kind,'life_id':principal if kind=='life' else None,'display_name':None}

    def source_timestamp(value):
        # Host Room metadata supplies a timezone-bearing ISO timestamp. Preserve
        # its original value/precision; neither transport time nor body prose is
        # evidence of a sender's historical message time.
        if not isinstance(value,str):return None
        try:
            parsed=datetime.fromisoformat(value.replace('Z','+00:00'))
            if parsed.tzinfo is None or parsed.utcoffset() is None:return None
            return value
        except (ValueError,OverflowError):return None

    def native_timestamp(event):
        value=event.get('time')
        if isinstance(value,bool) or not isinstance(value,(int,float)) or not math.isfinite(value):return None
        try:return datetime.fromtimestamp(value/1000,timezone.utc).isoformat()
        except (ValueError,OverflowError,OSError):return None

    def add_peer(rows,locations,item,line,event,message,record_id):
        content='\n'.join(block['text'] for block in message.get('content',[]) if block.get('type')=='text')
        if not content:return
        source=message['source'];sender=peer_sender(source)
        if source.get('receiverLifeId',owner['lifeId'])!=owner['lifeId']:
            raise PermissionError('MEMORY_PEER_RECEIVER_MISMATCH')
        sent_at=source_timestamp(source.get('messageTimestamp'));received_at=source_timestamp(source.get('receivedAt'))
        materialized_at=native_timestamp(event);timeline_seq=source.get('messageTimelineSeq')
        if isinstance(timeline_seq,bool) or not isinstance(timeline_seq,int) or timeline_seq<1:timeline_seq=None
        rows.append({'id':record_id,'conversation_id':item['sessionId'],'role':sender['sender_type'],'transport_role':message.get('role','user'),'content':content,
            'created_at':sent_at if sent_at is not None else materialized_at,
            'message_sent_at':sent_at,'received_at':received_at,'observed_at':materialized_at,'native_materialized_at':materialized_at,
            'message_timeline_seq':timeline_seq,
            'time_provenance':{'created_at':'source.messageTimestamp' if sent_at is not None else 'native-event-observation-only; message-sent-time-unknown',
                'message_sent_at':'source.messageTimestamp' if sent_at is not None else 'unknown',
                'message_timestamp_status':'valid' if sent_at is not None else 'unknown' if source.get('messageTimestamp') is None else 'invalid',
                'received_at':'source.receivedAt' if received_at is not None else 'unknown',
                'observed_at':'native-event.time' if materialized_at is not None else 'unknown',
                'native_materialized_at':'native-event.time' if materialized_at is not None else 'unknown'},
            'source':source['kind'],'source_metadata':source,'sender_principal_id':source.get('senderPrincipalId'),'sender':sender,
            'receiver_life_id':owner['lifeId'],'experienced_by_life_id':owner['lifeId'],'experience_kind':'received_social_message',
            'delegation_depth':item['header'].get('delegationDepth',0),
            'provenance_kind':'received_peer_message; sender is not the recipient self'})
        locations[(str(item['sessionId']),str(record_id))]=(item['path'],line)

    def native_actor():
        matches=[]
        for item in sessions:
            if item['sessionId']!=owner['sessionId']:continue
            records=read_lines(Path(item['path']),native=True)
            if not records or records[0][1]!=item['header']:raise PermissionError('MEMORY_NATIVE_IDENTITY_CHANGED')
            for _,event in records[1:]:
                if event.get('type')!='tool/call':continue
                data=event.get('data',{})
                if data.get('callId')!=owner.get('callId'):continue
                if data.get('name')!='memory_'+request['operation']:raise PermissionError('MEMORY_RECEIPT_OPERATION_MISMATCH')
                try:args=json.loads(data['arguments']) if isinstance(data.get('arguments'),str) else data.get('arguments')
                except ValueError:raise PermissionError('MEMORY_RECEIPT_ARGUMENTS_INVALID') from None
                if compact(args)!=compact(request['receiptArguments']):raise PermissionError('MEMORY_RECEIPT_ARGUMENTS_MISMATCH')
                matches.append((event,item['path']))
        if len(matches)!=1:raise PermissionError('MEMORY_NATIVE_RECEIPT_MISSING_OR_AMBIGUOUS')
        event,path=matches[0]
        return {'kind':'persona' if owner['self'] else 'child_suggestion',
                'life_id':owner['lifeId'],'session_id':owner['sessionId'],'session_role':owner['role'],
                'call_id':owner['callId'],'seq':event['seq'],'native_path':path,
                'recorded_at':datetime.fromtimestamp(event['time']/1000,timezone.utc).isoformat()}

    class ScopedMemory(Memory):
        def append(self,operation,payload,actor):
            actor=dict(actor)
            # 'persona' is solely the old engine's temporary self-author role.
            # New journals keep the actual owner and role, never that identity.
            if actor.get('kind')=='persona':actor['kind']='life_self'
            actor['life_id']=owner['lifeId']
            return super().append(operation,payload,actor)
        def api_audit(self,record):
            super().api_audit({**record,'life_id':owner['lifeId'],'session_id':owner['sessionId'],
                'run_id':owner['runId'],'request_id':owner['requestId'],'call_id':owner['callId'],
                'cost_category':owner['costCategory'],'credential_ref':request.get('credentialRef')})
        def open(self,*args,**kwargs):
            result=super().open(*args,**kwargs)
            view=kwargs.get('view',args[1] if len(args)>1 else 'summary')
            if view=='summary':
                # Preserve Unicode paging by editing before paginate, not after.
                event=self.event(kwargs.get('event_id',args[0] if args else None))
                value={k:v for k,v in event.items() if k not in ('units','accepted_hashes')}
                value.update(tags=self.tags(event),summary_author=owner['lifeId'],
                    summary_kind='current authored view with historical notes separately preserved')
                result=self.paginate(json.dumps(value,ensure_ascii=False,indent=2),kwargs.get('offset',0),kwargs.get('limit',6000))
            return result
        def export_catalog(self):
            events=[];offset=0
            while True:
                page=self.catalog(offset,100);events+=page['events']
                if page['next_offset'] is None:break
                offset=page['next_offset']
            lines=['# '+str(owner['displayName'] or owner['lifeId'])+' 的记忆目录','',
                   f'生成观察时间：{now()}。标题和一句话由本主体署名；仅覆盖已整理子集。','',
                   '这是按需阅读入口，不自动进入 Core 或日常上下文。原文通过 memory_open 明确打开。','']
            for e in events:lines.extend([f"- {e['time'].get('start','未知时间')} · **{e.get('alias') or e['event_id']}: {e['name']}** · {e['status']}"+(' · 来源变化待复核' if e['needs_review'] else ''),f"  {e.get('one_line','')}  (`{e['event_id']}`)"])
            self.export.mkdir(parents=True,exist_ok=True)
            common={'life_id':owner['lifeId'],'generated_at':now()}
            atomic_json(self.export/'catalog.json',{**common,'events':events,'threads':self.catalog()['threads']})
            path=self.export/'catalog.md';temp=path.with_suffix('.tmp');temp.write_text('\n'.join(lines)+'\n',encoding='utf-8');temp.replace(path)
            atomic_json(self.export/'journal-export.json',{**common,'authority':'protected append-only journal; this is a rebuildable readable export','entries':self.ledger()})
            return {'life_id':owner['lifeId'],'catalog':str(path),'events':len(events),'github_published':False,'dots_read_verified':False}

    class SyntheticProvider:
        """Offline deterministic transport; accessible only to TEST ONLY contexts."""
        def __init__(self,config,audit):self.config=config;self.audit=audit
        def embed(self,texts):
            import time
            started=now();time.sleep(min(max(self.config.get('fixture_delay_ms',0),0),1000)/1000)
            self.audit({'operation':'embedding','synthetic':True,'ok':True,'usage':{'total_tokens':len(texts)},'started_at':started,'finished_at':now()})
            return [[1.0]+[.1+(i+1)/self.config['dimension'] for i in range(self.config['dimension']-1)] for _ in texts]
        def rerank(self,query,docs):
            self.audit({'operation':'rerank','synthetic':True,'ok':True})
            return [{'index':i,'score':.9-i*.01,'rank':i+1} for i in range(len(docs))]

    name=request['operation'];payload=request['arguments']
    if name in ('propose','accept','annotate','link'):
        expected=dict(request['receiptArguments'])
        if name=='propose' and 'event_json' in expected:expected['event']=json.loads(expected.pop('event_json'))
        if name=='annotate' and 'fields_json' in expected:expected['fields']=json.loads(expected.pop('fields_json'))
        if compact(expected)!=compact(payload):raise PermissionError('MEMORY_RECEIPT_PAYLOAD_MISMATCH')
    if binding['syntheticProvider'] and owner['kind']!='fixture':raise PermissionError('SYNTHETIC_PROVIDER_FIXTURE_ONLY')
    if name=='search' and not binding['syntheticProvider'] and not os.environ.get('DASHSCOPE_API_KEY'):
        raise PermissionError('MEMORY_CREDENTIAL_UNAVAILABLE')
    engine.snapshot=scoped_snapshot  # Scoped to this one-operation process only.
    sources={'sources':binding['sources'],'workspace':binding['workspace'],'native_sessions':'unused','selection_locators':'unused'}
    memory=ScopedMemory(base=binding['base'],store=store,sources=sources,config=binding['config'],
                        **({'client_factory':SyntheticProvider} if binding['syntheticProvider'] else {}))
    memory.export=Path(binding['exportRoot'])
    try:
        with memory.lock():
            actor=native_actor() if name in ('propose','accept','annotate','link') else None
            if name!='sync' and not(name=='open' and payload.get('view')=='source_conflicts'):memory.sync()
            result=operation(memory,name,payload,actor)
            if name in ('propose','accept','annotate','link'):memory.export_catalog()
            return {'ok':True,'lifeId':owner['lifeId'],'result':result}
    finally:memory.close()


if __name__=='__main__':
    try:print(json.dumps(main(),ensure_ascii=False))
    except Exception as error:
        # No arbitrary exception text, source content, credential or traceback.
        text=str(error)
        known=(ValueError,PermissionError,RuntimeError)
        if isinstance(error,known) and text.startswith(('MEMORY_','SYNTHETIC_')):code=text
        elif isinstance(error,ValueError) and text.startswith('Stale'):code='MEMORY_STALE_REVISION'
        elif isinstance(error,RuntimeError) and text.startswith('Memory writer busy'):code='MEMORY_WRITER_BUSY'
        else:code='MEMORY_OPERATION_FAILED: '+type(error).__name__
        print(json.dumps({'ok':False,'error':code}));sys.exit(1)
