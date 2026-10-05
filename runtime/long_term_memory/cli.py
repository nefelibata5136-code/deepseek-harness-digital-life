"""Protected CLI/JSON bridge. No model loop or automatic memory injection."""
import argparse
import json
import sys
from pathlib import Path
from engine import Memory,BASE,HERE
from import_design import import_design
from source_reader import resolve_actor,compact

def operation(memory,name,args,actor=None):
    if name=='sync':
        result=memory.sync()
        return {k:v for k,v in result.items() if k not in ('added','changed','deleted')}|{k+'_count':len(result[k]) for k in ('added','changed','deleted')}|{'changed_keys':result['changed'],'deleted_keys':result['deleted'],'new_messages':'Browse pending with a cursor; no automatic segmentation'}
    if name=='status':return memory.status()
    if name=='embed':return memory.embed(**args)
    if name=='search':return memory.search(**args)
    if name=='open':return memory.open(**args)
    if name=='catalog':return memory.catalog(**args)
    if name=='pending':return memory.pending(**args)
    if name=='export':return memory.export_catalog()
    if name=='rebuild':return memory.rebuild()
    if name=='import':return import_design(memory,args.get('design',Path(memory.sources['workspace'])/'memory/design'))
    if not actor:raise PermissionError('Mutation requires native author receipt')
    if name=='propose':return memory.register(args['event'],actor,args.get('event_id'),args.get('expected_revision'))
    if name=='accept':return memory.decide(args['event_id'],args.get('status','accepted'),actor,args['expected_revision'])
    if name=='annotate':return memory.annotate(args['event_id'],args['fields'],actor,args['expected_revision'],args.get('supersedes'))
    if name=='link':
        if actor['kind']!='persona':raise PermissionError('Child suggestions cannot finalize links')
        source=memory.event(args['from_event']);target=memory.event(args['to_event'])
        entry=memory.append('relation',{'from_event':source['event_id'],'to_event':target['event_id'],'relation':args['relation']},actor)
        return {'journal_seq':entry['seq'],'relation':entry['payload']}
    raise ValueError('Unknown operation')

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=['sync','status','embed','search','open','catalog','pending','export','rebuild','import','bridge'])
    parser.add_argument('--query');parser.add_argument('--event-id');parser.add_argument('--memory-id')
    parser.add_argument('--view',default='summary');parser.add_argument('--record-id')
    parser.add_argument('--include-test',action='store_true');parser.add_argument('--offset',type=int,default=0);parser.add_argument('--limit',type=int)
    parser.add_argument('--args-file',type=Path)
    args=parser.parse_args()
    memory=Memory()
    try:
        with memory.lock():
            actor=None
            if args.command=='bridge':
                request=json.loads(sys.stdin.read(2*1024*1024))
                name=request['operation'];payload=request.get('arguments',{})
                if name in ('import','rebuild','embed'):raise PermissionError('Bulk/control operations are maintainer CLI only')
                if name in ('propose','accept','annotate','link'):
                    actor=resolve_actor(memory.base,call_id=request.get('native_call_id'))
            else:
                name=args.command
                if args.args_file:payload=json.loads(args.args_file.read_text('utf-8'))
                elif name=='search':payload={'query':args.query,'include_test':args.include_test,**({'limit':args.limit} if args.limit else {})}
                elif name=='open':payload={'event_id':args.event_id,'view':args.view,'record_id':args.record_id,'memory_id':args.memory_id,'include_test':args.include_test,'offset':args.offset,**({'limit':args.limit} if args.limit else {})}
                elif name=='catalog':payload={'offset':args.offset,**({'limit':args.limit} if args.limit else {})}
                else:payload={}
            # Read operations refresh the raw hashes before serving accepted
            # memory, so changed/deleted sources cannot stay silently current.
            if name not in ('rebuild','sync') and not (name=='open' and payload.get('view')=='source_conflicts'):memory.sync()
            result=operation(memory,name,payload,actor)
            if name in ('propose','accept','annotate','link'):memory.export_catalog()
            print(json.dumps({'ok':True,'result':result},ensure_ascii=False))
    except Exception as e:
        # Only purposeful errors; never transport headers, environment, or raw
        # traceback strings from arbitrary libraries enter the model.
        if isinstance(e,(ValueError,PermissionError,RuntimeError)):
            message=str(e)
            from qwen import SECRET
            message=SECRET.sub('[credential-like content hidden]',message)
        else:message='MEMORY_OPERATION_FAILED: '+type(e).__name__
        print(json.dumps({'ok':False,'error':message},ensure_ascii=False));sys.exit(1)
    finally:memory.close()

if __name__=='__main__':main()
