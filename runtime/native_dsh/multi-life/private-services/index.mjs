import {fail} from '../contracts.mjs';
import {OwnerBindings} from './bindings.mjs';
import {createMemoryService} from './memory.mjs';
import {createVaultService} from './vault.mjs';
import {installSessionPrivacy,PRIVATE_NAMES,isPrivateCompletionAck} from '../../private-vault/session-privacy.mjs';

export function createPrivateServices({contexts,ownerBindings=new Map(),memoryBindings=new Map(),...options}) {
  if(!contexts?.require||!contexts?.requireAuthority)fail('TRUSTED_CONTEXTS_SERVICE_REQUIRED');
  const bindings=new OwnerBindings({contexts,bindings:ownerBindings});
  const memory=createMemoryService({contexts,ownerBindings:bindings,bindings:memoryBindings,...options});
  const vault=createVaultService({contexts});
  return {memory,vault,bindings,dispose:()=>vault.dispose()};
}

const string={type:'string'},integer={type:'integer'},boolean={type:'boolean'},strings={type:'array',items:string};
const memorySpecs=[
  ['search','Search this owner’s accepted/current memory entrances; open original evidence explicitly.',{query:string,limit:integer,candidates:integer,include_test:boolean,tags:strings,speaker:string,from_time:string,to_time:string},['query']],
  ['open','Read this owner’s memory and sources with explicit Unicode paging.',{event_id:string,view:{type:'string',enum:['summary','local','event','message','relations','versions','source_compare','source_conflicts','search_audit']},memory_id:string,record_id:string,namespace:string,conversation:string,offset:integer,limit:integer,include_test:boolean,version:string,search_id:string},['view']],
  ['catalog','Page this owner’s authored event catalog; decisions and review status are preserved.',{offset:integer,limit:integer,tags:strings,status:string}],
  ['pending','Page this owner’s unorganized source messages; no automatic event segmentation.',{offset:integer,limit:integer,namespace:string,conversation:string}],
  ['status','Inspect this owner’s memory counts and attributed provider audit. No provider debit proof.',{}],
  ['sync','Observe this owner’s source additions, edits and deletions without accepting memories.',{}],
  ['export','Write this owner’s rebuildable memory catalog and journal export locally.',{}],
  ['propose','Propose an event with exact source refs; delegated proposals are marked as suggestions.',{event_json:string,event_id:string,expected_revision:integer},['event_json'],args=>{const {event_json,...rest}=args;return {...rest,event:JSON.parse(event_json)};}],
  ['accept','This owner’s authority Session accepts, rejects or withdraws memory with an expected revision.',{event_id:string,status:{type:'string',enum:['accepted','candidate','withdrawn','rejected']},expected_revision:integer},['event_id','expected_revision']],
  ['annotate','This owner’s authority Session appends annotations; superseded text remains in history.',{event_id:string,fields_json:string,expected_revision:integer,supersedes:string},['event_id','fields_json','expected_revision'],args=>{const {fields_json,...rest}=args;return {...rest,fields:JSON.parse(fields_json)};}],
  ['link','This owner’s authority Session appends a relation between its own memory events.',{from_event:string,to_event:string,relation:string},['from_event','to_event','relation']],
];
const vaultSpecs={write:{namespace:string,path:string,value:string},read:{namespace:string,path:string},delete:{namespace:string,path:string},
  list:{namespace:string,prefix:string,offset:integer,limit:integer},search:{namespace:string,prefix:string,offset:integer,limit:integer,query:string}};
const safeError=error=>typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'PRIVATE_SERVICE_OPERATION_FAILED';

// Shared definitions, bound only at execution. No life selector in tool schemas.
export function privateServiceTools({contexts,services,privacy}) {
  const tool=(name,description,properties,required,execute)=>({name,description,
    parameters:{type:'object',properties,required:required??[],additionalProperties:false},
    isConcurrencySafe:()=>true,
    output:{schema:{type:'object'},render:(_args,result)=>[{type:'text',text:JSON.stringify(result)}],
      ...(PRIVATE_NAMES.includes(name)?{presentationMeta:(_args,result)=>({privateVault:{operation:name,ok:result.ok===true,...(result.error?{error:result.error}:{})}})}:{})},
    async execute(args,exec){try{return await execute(args,exec);}catch(error){return {ok:false,error:safeError(error)};}}});
  const definitions=memorySpecs.map(([operation,description,properties,required,transform=args=>args])=>tool('memory_'+operation,description,properties,required,async(args,exec)=>{
    const context=contexts.execution(exec.agent,{callId:exec.callId,costCategory:'memory'});
    return services.memory.execute(context,operation,transform(args),{signal:exec.signal,receiptArguments:args});
  }));
  for(const name of PRIVATE_NAMES) {
    const operation=name.slice('private_'.length),properties=vaultSpecs[operation];
    definitions.push(tool(name,'Use this owner’s private encrypted namespace/path storage; delegates have no access.',properties,
      operation==='write'?['path','value']:['read','delete'].includes(operation)?['path']:operation==='search'?['query']:[],async(args,exec)=>{
        const context=contexts.execution(exec.agent,{callId:exec.callId,costCategory:'private-vault'});
        if(!privacy?.active(exec.agent.session))fail('VAULT_PRIVATE_TURN_REQUIRED');
        return services.vault.execute(context,operation,args);
      }));
  }
  return definitions;
}

// Integration seam for bootScoped.extensions, before any native Agent is created.
export function mountPrivateServices({ctx,contexts,allowFullAccessPrivateTools=()=>false,allowPrivateOperation=()=>false,...options}) {
  const services=createPrivateServices({contexts,...options}),privacy=installSessionPrivacy(ctx);
  ctx.tools.guard(exec=>{
    if(!privacy.active(exec.agent?.session)||PRIVATE_NAMES.includes(exec.name))return;
    const context=contexts.execution(exec.agent,{callId:exec.callId});
    if(context.role!=='delegate'&&exec.name==='life_turn_ack'&&isPrivateCompletionAck(exec.arguments))return;
    return allowFullAccessPrivateTools(context)===true||allowPrivateOperation(context,exec)===true?undefined:'PRIVATE_CONTEXT_TOOL_BLOCKED';
  });
  for(const definition of privateServiceTools({contexts,services,privacy}))ctx.tools.register(definition);
  ctx.provide('multiLifePrivateServices',services);
  ctx.effect(()=>()=>services.dispose(),'per-life private service ownership');
  return services;
}
