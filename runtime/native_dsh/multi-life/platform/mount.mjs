import {defineTool} from '@deepseek-ai/dsh-tools';
import {Conversations} from './conversations.mjs';
import {ResourceBroker} from './resources.mjs';
import {TaskStore} from './tasks.mjs';
import {FairAdmission} from './fair-admission.mjs';
import {PublicActivityStore} from './public-activity.mjs';
import {nativeToolResultForCall} from './inbox-recovery.mjs';
import {resolve} from 'node:path';
import {fail} from '../contracts.mjs';
import {SocialCommunication,socialView,speechParameters,speechDescription} from './social.mjs';

export function mountPlatform(host,{root,externalWorld=false}) {
  const {ctx,contexts,runtime,locks}=host;
  contexts.registry.addControlRoot(root);
  const taskStore=new TaskStore({contexts,root:resolve(root,'tasks')});
  const rooms=new Conversations({contexts,root:resolve(root,'conversations'),tasks:taskStore});
  const social=new SocialCommunication(rooms);
  const fair=new FairAdmission({registry:contexts.registry,contexts,...host.fairPolicy});
  const activity=new PublicActivityStore({contexts,root:resolve(root,'public-activity')});
  runtime.tasks=taskStore;runtime.rooms=rooms;contexts.tasks=taskStore;
  ctx.effect(()=>()=>rooms.close(),'durable social history stores');
  ctx.effect(()=>()=>fair.dispose(),'per-life reserved model capacity');
  ctx.on('llm/stream',async function*(options,next){
    const agent=ctx.agents.get(options.sessionId);if(!agent)fail('UNATTRIBUTED_MODEL_REQUEST');
    const c=contexts.execution(agent),lease=await fair.acquire(c,{signal:options.signal});
    try{options.signal?.throwIfAborted();contexts.require(c);yield* next();}finally{lease.release();}
  },{prepend:true});
  ctx.on('session/event',(session,event)=>{
    let owner;try{owner=contexts.registry.owner(session.id);}catch(error){if(error.code!=='UNKNOWN_SESSION_OWNER')throw error;}
    if(owner?.status==='ready') {
      if(event.type==='turn/start')activity.recordHost({lifeId:owner.lifeId,sessionId:session.id,phase:'thinking'});
      if(event.type==='tool/call')activity.recordHost({lifeId:owner.lifeId,sessionId:session.id,phase:'tool',toolName:event.data.name});
      if(event.type==='turn/end')activity.recordHost({lifeId:owner.lifeId,sessionId:session.id,phase:'idle'});
    }
    if(event.type!=='turn/end')return;
    const row=taskStore.forSession(session.id);if(!row||row.kind!=='delegate'||row.status==='completed')return;
    const events=[...session.ownEvents()],final=events.findLast(e=>e.type==='assistant/message');
    taskStore.complete({taskId:row.task_id,result:{outcome:event.data.reason?.kind??'unknown',message:final?.data??null},
      nativeEvidence:{session_id:session.id,seq:event.seq,assistant_seq:final?.seq??null}});
  });
  const resources=new ResourceBroker({contexts,locks});
  const definitions=[
    ['life_contact_list','查看可以交流的主体与公开/私密方式。',{},c=>social.contacts(c)],
    ['life_event_read','按事件 ID 读取本人可见的完整事件。',{event_id:{type:'string',required:true}},(c,args)=>social.read(c,args)],
    ['life_send_message',speechDescription,{...speechParameters,publish_private_turn:{type:'boolean'}},(c,args)=>{
      const {publish_private_turn,...speech}=args;return social.speak(c,speech,c.callId);
    }],
    ['life_action_result','只读确认现实行动结果；使用 event_id、in_response_to 或本 Session call_id。unknown 先核实原行动。',
      {event_id:{type:'string'},in_response_to:{type:'string'},call_id:{type:'string'}},(c,args,exec)=>{
      contexts.require(c);
      if(args.call_id!==undefined){
        if(typeof args.call_id!=='string'||!args.call_id||Object.keys(args).some(key=>key!=='call_id'))fail('ACTION_RESULT_REFERENCE_CONFLICT');
        const native=nativeToolResultForCall({events:[...exec.agent.session.ownEvents()],callId:args.call_id});
        return native.status==='unknown'?social.result(c,{operation_id:args.call_id}):socialView(native);
      }
      return social.result(c,args);
    }],
    ['life_receive_message','读取本人 durable Inbox、decision_token 与客观 effect_result。pending 表示输入仍需本人处理，attempt 只记录执行。received_at 是 Host enqueue，不是已读。每项独立决定，不要求回复。',{after:{type:'integer'},limit:{type:'integer'},includeTerminal:{type:'boolean'}},(c,args)=>rooms.receive(c,args)],
    ['life_message_timeline','读取本人可见的统一消息事件流，保留主体与私密/公开性质；不合并私人记忆。',{after:{type:'integer'},limit:{type:'integer'}},(c,args)=>social.messages(c,args)],
    ['observe_life','Read a life\'s public activity only: busy state, public tool name and voluntary public explanation. Private content is never exposed.',{life_id:{type:'string',required:true}},(_c,args)=>activity.read(args.life_id)],
    ['life_activity_publish','Publish or withdraw your own short public activity explanation. visibility=private withdraws the text without persisting it.',{text:{type:'string',required:true},visibility:{type:'string'},expiresAt:{type:'string'}},(c,args)=>activity.publish(c,args)],
    ['life_message_decide','由本人决定输入是否仍需继续，不执行发送。complete 完成；continue 保留未完成输入；process 明确请求下一次空闲处理；defer 延期（until 省略为无限期）；ignore 不再处理。使用收到的 decision_token 或 event_id。现实行动成功不能替代你的语义决定。',{decision_token:{type:'string'},event_id:{type:'string'},expectedRevision:{type:'integer'},action:{type:'string',enum:['complete','continue','process','defer','ignore'],required:true},until:{type:'string'}},(c,args)=>social.decide(c,args)],
    ['life_task_list','List only your own tasks, parent ownership and Room origin.',{},c=>taskStore.list(c)],
    ['life_task_results','Receive your own delegated results. They are never routed to another life by Session guesses.',{after:{type:'integer'},limit:{type:'integer'}},(c,args)=>taskStore.readResults(c,args)],
    ['life_task_result_ack','Acknowledge your own task result without deleting its evidence.',{taskId:{type:'string',required:true}},(c,args)=>taskStore.acknowledgeResult(c,args)],
    ['life_resource_status','Inspect your own reserved and elastic model capacity.',{},c=>fair.snapshot(c)],
    ['life_session_list','List your own native Sessions without waking a model.',{},c=>contexts.registry.sessions(c.lifeId).map(({sessionId,role,status})=>({sessionId,role,status}))],
    ['life_session_read','Read your own native journal by complete records.',{sessionId:{type:'string',required:true},after:{type:'integer'},limit:{type:'integer'}},async(c,{sessionId,after=-1,limit=50})=>{
      contexts.target(c,sessionId);if(!Number.isSafeInteger(after)||after<-1||!Number.isSafeInteger(limit)||limit<1||limit>100)fail('EXPLICIT_SESSION_PAGE_REQUIRED');
      const events=(await runtime.events({lifeId:c.lifeId,sessionId})).filter(e=>e.seq>after),page=events.slice(0,limit);
      return {events:page,nextAfter:page.at(-1)?.seq??after,hasMore:events.length>page.length};
    }],
    ['life_delegate','Delegate a self-contained task. Production default is Codex GPT-5.6 Luna. DeepSeek delegation is disabled until deepseekEnabled is deliberately enabled in router settings. Luna returns immediately; completion returns to this parent Session, and subagent_results reads the full result. This does not create a digital life.',{task:{type:'string',required:true},provider:{type:'string'},model:{type:'string'},run_in_background:{type:'boolean'}},async(c,args)=>{
      const result=await runtime.delegate(c,args);const {agent,...receipt}=result;return receipt;
    }],
  ];
  const remoteNames=new Set(['life_contact_list','life_event_read','life_send_message','life_action_result','life_receive_message','life_message_timeline','observe_life','life_activity_publish','life_message_decide']);
  for(const [name,description,parameters,run] of definitions.filter(d=>!externalWorld||!remoteNames.has(d[0])))ctx.tools.register(defineTool({name,description,parameters,
    output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},
    execute:async(args,exec)=>socialView(await run(contexts.execution(exec.agent,{callId:exec.callId}),args,exec))}));
  return {rooms,resources,taskStore,fair,activity};
}
