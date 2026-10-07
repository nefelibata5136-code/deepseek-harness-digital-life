// Native Digital Life preset extension. The trusted Host binds transport and
// identity; all tools and hooks stay on the original Agent's Cordis scope.
import {defineTool} from '@deepseek-ai/dsh-tools';
import {fail} from '../multi-life/contracts.mjs';
import {nativeToolResultForCall} from '../multi-life/platform/inbox-recovery.mjs';
import {socialView,speechParameters,speechDescription} from '../multi-life/platform/social.mjs';
import {mountRecentEventsWorker} from '../multi-life/recent-events/worker.mjs';
const string=(required=false)=>({type:'string',...required?{required:true}:{}});
const integer=()=>({type:'integer'});
function fields(value,allowed) {
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail('SOCIAL_ARGUMENT_INVALID');
  return {...value};
}
export function attachSocialCapabilities(agent,binding,ctx) {
  const {lifeId,sessionId:authoritySessionId,role,rpc,requireExecution,ownDisposer}=binding;
  function install(agent) {
    const add=(name,description,parameters,operation,allowed,wrap=value=>value)=>ownDisposer(agent.ctx.tools.register(defineTool({
      name,description,parameters,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      isConcurrencySafe:()=>true,
      async execute(args,exec) {
        requireExecution(exec);const input=wrap(fields(args,allowed),exec);const result=await rpc(operation,input,exec.signal);requireExecution(exec);return socialView(result);
      }
    })));
    const social=(operation,args)=>({social:{operation,sessionId:authoritySessionId,args}});
    add('life_contact_list','查看可以交流的主体及私密/公开方式；不选择聊天房间。',{},'timeline',[],args=>social('contacts',args));
    add('life_event_read','按稳定事件 ID 读取本人可见的完整事件，保留主体、性质和来源正文。',{event_id:string(true)},'timeline',['event_id'],args=>social('read',args));
    add('life_send_message',speechDescription,speechParameters,'timeline',
      ['to','visibility','body','in_response_to'],(args,exec)=>({social:{operation:'speak',sessionId:authoritySessionId,args,callId:exec.callId}}));
    add('life_receive_message','查看本人持久 Inbox，每项含 decision_token，可直接决定而无需 ID join。received_at 是持久入箱时间，不是已读或思考时间。完整分页后可见所有 pending。',{after:integer(),limit:integer(),includeTerminal:{type:'boolean'}},'inbox',['after','limit','includeTerminal']);
    ownDisposer(agent.ctx.tools.register(defineTool({name:'life_action_result',
      description:'只读核对现实行动。用 event_id、in_response_to 或仅本 Session 的 call_id。unknown 先查原行动身份，不盲重发。',
      parameters:{call_id:string(),event_id:string(),in_response_to:string()},
      output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},isConcurrencySafe:()=>true,
      async execute(args,exec){requireExecution(exec);const input=fields(args,['call_id','event_id','in_response_to']);
        if(input.call_id!==undefined){if(Object.keys(input).length!==1)fail('ACTION_RESULT_SELECTOR_CONFLICT');
          const events=[...exec.agent.session.ownEvents()],native=nativeToolResultForCall({events,callId:input.call_id});
          const original=events.find(event=>event.type==='tool/call'&&event.data.callId===input.call_id&&event.data.name==='life_send_message');
          if(native.status==='unknown'&&original){
            let speech;try{speech=JSON.parse(original.data.arguments);}catch{return socialView(native);}
            let receipt;try{receipt=await rpc('timeline',social('result',{operation_id:input.call_id,speech}),exec.signal);}
            catch(error){return {...socialView(native),reconcile_error:/^[A-Z_]{1,128}$/.test(error.code??'')?error.code:'ACTION_READBACK_UNAVAILABLE'};}
            requireExecution(exec);if(receipt?.status==='confirmed_success')return {...socialView(receipt),native_result_status:native.status,native_call_id:input.call_id};
          }
          return socialView(native);}
        const value=await rpc('timeline',social('result',input),exec.signal);requireExecution(exec);return socialView(value);
      }
    })));
    add('life_message_timeline','查看本人可见的统一事件消息时间线。保留主体、公开/私密性质和事件 ID。',
      {after:integer(),limit:integer()},'timeline',['after','limit'],args=>social('messages',args));
    add('observe_life','查看一个数字生命自愿公开的活动说明与 Host 公有运行元信息。最后公开工具名不是 read receipt，不能据此判断读了哪条消息；不读取私人参数、思考、Memory 或 Core。',
      {life_id:string(true)},'observe',['life_id']);
    add('life_activity_publish','管理你自己的公开活动说明。public 自愿向其他主体公开，private 撤下公开说明且不保存提交的文本；expiresAt 可用 ISO 时间。',
      {text:string(true),visibility:{type:'string',enum:['public','private']},expiresAt:string()},'activity',['text','visibility','expiresAt'],args=>({sessionId:authoritySessionId,args}));
    add('life_message_decide','本人决定输入语义：complete=已经完成，continue/process=仍想继续，ignore=主动不处理，defer=延期。发送本身不会完成输入；对外回复只用 life_send_message。decision_token 或 event_id 定位真实输入。执行失败历史不会覆盖本人的决定。',
      {decision_token:string(),event_id:string(),action:{type:'string',enum:['complete','continue','defer','ignore','process'],required:true},expectedRevision:integer(),expected_revision:integer(),until:{oneOf:[string(),{type:'null'}]}},'timeline',
      ['event_id','decision_token','action','expectedRevision','expected_revision','until'],args=>{
        if(args.decision_token===undefined&&args.expectedRevision===undefined&&args.expected_revision===undefined)fail('INBOX_REVISION_REQUIRED');return social('decide',args);
      });
    ownDisposer(agent.ctx.systemPrompt.section({name:'life:room-worker-binding',order:90,interpolate:false,
      text:()=>binding.enabled()?'发言身份由 Host 固定绑定为本 Session 的 owner life，模型参数不能选择身份。'+
        (role==='authority'?'这个 Session 是该 life 的日常 authority 席位。':'这个 Session 是同一 life 所有的独立 activity 活动对话，不是日常主线，也不是新生命。保留既有副对话的独立身份与用途提示，不自行宣称为主线。')+
        'life_contact_list 发现主体，life_event_read 按事件读取；说话选择 to 联系人名字、visibility=private/public，可选 in_response_to 事件。Host 负责路由；life_receive_message 每项给 decision_token 和客观 effect_result。life_send_message 是唯一对外入口；发送成功只证明消息存在。输入是否完成由你使用 life_message_decide(complete/continue/defer/ignore) 或 life_turn_ack.completed_event_ids 明确选择；不从发消息或 turn 成功推定。unknown 行动先查 life_action_result 和原生 tool/result，保留原行动身份，不盲重试。timeline_seq 是全局持久提交顺序，权限可导致跳号。received_at 是落入持久 Inbox 的时间，不是阅读或开始思考时间。observe_life 的最后工具名不是已读回执。私人推理、Memory、Vault不共享；life_activity_publish 只发布本人选择的公开说明。消息不会冒充用户，不抢占正在运行的推理，也不自动成为记忆。':''}));
  }
  install(agent);
  const recent=mountRecentEventsWorker({ctx,agent,lifeId,sessionId:authoritySessionId,role,rpc,verify:()=>requireExecution({agent})});
  ownDisposer(()=>recent.dispose());return recent;
}
export const inject=['tools','systemPrompt','sessions'];
export function apply(ctx) {
  const attached=new WeakMap();
  ctx.provide('digitalLifeSocial',Object.freeze({
    nativePreset:true,version:1,loop:'DSH native',
    attach(agent,binding) {
      binding.verify(agent);
      if(attached.has(agent))return attached.get(agent);
      const recent=attachSocialCapabilities(agent,binding,ctx);attached.set(agent,recent);return recent;
    }
  }));
}
