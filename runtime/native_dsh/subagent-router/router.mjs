import {readFile,mkdir,appendFile,writeFile,rename,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import * as OfficialCodex from '@deepseek-ai/dsh-subagent-codex';
import {createCodexAdvisor} from '../digital-life/codex-advisor.mjs';
import {acquireSlot} from './slots.mjs';

export const name='life-subagent-router';
export const inject=['tools','subagents','subprocess','systemPrompt','agents','sessions'];
export const capabilityText='普通 subagent / life_delegate 默认派 GPT-5.6 Luna（Codex）。可积极委派值得独立完成的自包含任务，由你判断是否值得派；不强制每件事都派 Agent。DeepSeek 子 Agent 开关默认关闭，显式指定也会被拒绝；你可以自主修改 subagent-router/settings.json 的 deepseekEnabled 后按 README 重载，保留原实现。provider="codex", model="精确模型ID" 可选择其他 Codex 模型。Luna 是完全访问工程 worker，可按委派读取/修改文本文件、运行 shell 命令和联网；从你的工作目录运行，只收到明确任务与 Host 固定的父主体身份，不自动继承你的完整对话或记忆。读取文本使用 shell（如 PowerShell Get-Content），图像 read/view 工具只读图像。所有委派包括 subagent_codex 均后台提交即返回 child_id，run_in_background:false 仅兼容旧参数，不等待子任务；你可以继续其他工作，完成后通知原父 Session，subagent_results 按 child_id 查完整结果。不会静默 fallback。源码与调参入口：runtime/native_dsh/subagent-router/README.md。';
const textOutput={schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]};
const str={type:'string'};
const backendAliases=new Map([['luna','codex'],['deepseek','spawn'],['deepseek-official','spawn']]);
export function selectRoute(settings,args={}) {
  const provider=backendAliases.get(args.provider)??args.provider??settings.defaultProvider;
  const model=args.model??(provider==='codex'?settings.defaultModel:undefined);
  if(typeof provider!=='string'||!provider.trim()||model!==undefined&&(typeof model!=='string'||!model.trim()))throw new Error('SUBAGENT_ROUTE_INVALID');
  return {provider,model};
}
export class AgentRouter {
  constructor(ctx,settings,{ownerFor,deepseekStart,notify=true,slotRoot}={}) {
    this.ctx=ctx;this.settings=settings;this.ownerFor=ownerFor;this.deepseekStart=deepseekStart;this.notify=notify;
    this.rows=new Map();this.providers=new Map();this.pending=new Set();
    this.wireContext=new AsyncLocalStorage();
    this.slotRoot=slotRoot??join(settings.protectedRoot,'luna-slots');
    this.auditRoot=join(settings.protectedRoot,'subagent-audit');
    for(const key of ['maxConcurrency','runTimeoutMs','queueTimeoutMs'])if(!Number.isSafeInteger(settings[key])||settings[key]<1)throw new Error('SUBAGENT_SETTINGS_INVALID');
  }
  owner(parent) {
    const policy=this.ctx.get?.('normalInterfaceOwnership');
    const c=policy?policy.forAgent(parent):this.ownerFor?.(parent);
    if(!c?.lifeId||c.sessionId!==String(parent.session.id))throw new Error('SUBAGENT_TRUSTED_OWNER_REQUIRED');
    if(c.role==='delegate'||(parent.session.header.delegationDepth??0)>=1)throw new Error('SUBAGENT_DEPTH_EXCEEDED');
    return c;
  }
  async provider(model) {
    if(this.providers.has(model))return this.providers.get(model);
    const loading=(async()=>{
      const key='codex-luna-route-'+randomUUID();
      const home=join(this.settings.protectedRoot,'codex-home');
      // Official package owns protocol, process launch, transport and teardown.
      let raw;
      // Register the owner-checking wrapper in the live registry. The official
      // inner provider is private: its session surrogate must never be
      // mistaken for a live owner Agent by the normal-interface policy.
      const providerCtx={subagents:{registerProvider:provider=>{raw=provider;}},logger:this.ctx.logger,subprocess:{spawn:spec=>{
        const handle=this.ctx.subprocess.spawn(spec),row=this.wireContext.getStore();
        let incoming='';
        // Passive metadata observation only. The official provider exclusively
        // sends RPCs and owns all response/error/protocol handling.
        if(row)handle.stdout.on('data',chunk=>{
          incoming+=chunk.toString();
          while(incoming.includes('\n')) {
            const end=incoming.indexOf('\n'),line=incoming.slice(0,end);incoming=incoming.slice(end+1);
            let frame;try{frame=JSON.parse(line);}catch{continue;}
            if(frame.result?.thread&&frame.result.model) {
              row.actual_model=frame.result.model;row.codex_thread_id=frame.result.thread.id;
              row.sandbox_policy=frame.result.sandbox?.type??frame.result.sandboxPolicy?.type??null;
              row.approval_policy=frame.result.approvalPolicy??null;
            }
            if(frame.method==='item/started'&&frame.params?.item?.type==='commandExecution')row.command_count=(row.command_count??0)+1;
            if(frame.method==='item/completed'&&frame.params?.item?.type==='commandExecution'){
              row.command_exit_codes??=[];row.command_exit_codes.push(frame.params.item.exitCode??null);
            }
            if(frame.method==='turn/completed')row.codex_turn_status=frame.params?.turn?.status??null;
            if(frame.method==='error'){
              row.codex_error=true;row.codex_error_count=(row.codex_error_count??0)+1;
              row.codex_error_will_retry=frame.params?.willRetry===true;
              const info=frame.params?.error?.codexErrorInfo;
              if(typeof info==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(info))row.codex_error_info=info;
            }
          }
          if(incoming.length>1048576)incoming='';
        });
        return handle;
      }}};
      OfficialCodex.apply(providerCtx,{providerName:key,model,permissionMode:this.settings.permissionMode??'dangerously-bypass-approvals-and-sandbox',disposeGraceMs:1000,
        env:{CODEX_HOME:home,HOME:home,USERPROFILE:home}});
      if(!raw)throw new Error('LUNA_OFFICIAL_PROVIDER_MISSING');
      const wrapped=createCodexAdvisor(raw,{protectedRoot:this.settings.protectedRoot,providerName:key,
        contextForParent:parent=>this.owner(parent)}).provider;
      this.ctx.subagents.registerProvider(wrapped);
      return this.ctx.subagents.getProvider(key);
    })();
    this.providers.set(model,loading);try{return await loading;}catch(e){this.providers.delete(model);throw e;}
  }
  async audit(parent,row) {
    const {output,controller,...facts}=row;
    await mkdir(this.auditRoot,{recursive:true});
    const directory=this.resultDirectory(row.parent_life,row.parent_session);
    await mkdir(directory,{recursive:true});
    const target=join(directory,row.child_id+'.json'),temporary=target+'.'+randomUUID()+'.tmp';
    await writeFile(temporary,JSON.stringify(this.facts(row,true)),{mode:0o600});
    await rename(temporary,target);
    await appendFile(join(directory,'audit.jsonl'),JSON.stringify(facts)+'\n');
  }
  resultDirectory(life,session){return join(this.auditRoot,createHash('sha256').update(life+'\0'+session).digest('hex'));}
  async start(parent,args={},signal=new AbortController().signal) {
    const owner=this.owner(parent),route=selectRoute(this.settings,args),task=args.prompt??args.task;
    if(typeof task!=='string'||!task.trim())throw new Error('SUBAGENT_SELF_CONTAINED_TASK_REQUIRED');
    this.ctx.get?.('normalInterfaceOwnership')?.assertText(owner,task);
    signal.throwIfAborted();
    if(route.provider!=='codex') {
      if(route.provider==='spawn'&&this.settings.deepseekEnabled!==true)throw new Error('DEEPSEEK_SUBAGENTS_DISABLED');
      if(route.provider==='spawn'&&this.deepseekStart)return {...await this.deepseekStart(owner,{...args,run_in_background:true},signal),background:true};
      const request={parent,prompt:[{type:'text',text:task}],label:args.description??'Delegated task',signal,maxDepth:1,
        toolFilter:{allow:['read','skill','web_fetch']},
        ...route.provider==='spawn'?{agentOptions:{provider:'deepseek-official',model:route.model??'deepseek-flash'}}:route.model?{agentOptions:{model:route.model}}:{}};
      if(!this.ctx.subagents.getProvider(route.provider))throw new Error('SUBAGENT_PROVIDER_UNAVAILABLE:'+route.provider);
      if(route.provider==='spawn') {
        const child=await this.ctx.subagents.startContinuable({provider:route.provider,request,label:request.label,signal});
        return {child_id:child.childId,subagentId:child.childId,provider:route.provider,model:request.agentOptions.model,parent_life:owner.lifeId,continuable:true,background:true};
      }
      // Extensible providers must use the existing native background lifecycle;
      // a provider without it is refused rather than silently blocking the parent.
      if(!this.ctx.subagents.getProvider(route.provider).prepareContinuable)throw new Error('SUBAGENT_BACKGROUND_UNAVAILABLE:'+route.provider);
      const child=await this.ctx.subagents.startContinuable({provider:route.provider,request,label:request.label,signal});
      return {child_id:child.childId,subagentId:child.childId,provider:route.provider,model:route.model??null,parent_life:owner.lifeId,continuable:true,background:true};
    }
    const controller=new AbortController(),row={child_id:randomUUID(),backend_child_id:null,parent_life:owner.lifeId,
      parent_session:String(parent.session.id),worker_pid:process.pid,provider:'codex',model:route.model,status:'queued',queued_at:new Date().toISOString(),
      started_at:null,finished_at:null,failed_at:null,duration_ms:null,startup_ms:null,fallback:false,background:true,wait_requested:args.run_in_background===false,controller};
    this.rows.set(row.child_id,row);await this.audit(parent,row);
    const work=this.execute(parent,task,row,true).finally(()=>this.pending.delete(work));
    this.pending.add(work);work.catch(()=>{});
    return this.facts(row);
  }
  facts(row,result=false) {const {controller,output,...facts}=row;return {...facts,...result?{output:output??[]}:{}};}
  async execute(parent,task,row,background=true) {
    let lease,run,timer;const began=Date.now();
    try {
      const queueSignal=AbortSignal.any([row.controller.signal,AbortSignal.timeout(this.settings.queueTimeoutMs)]);
      lease=await acquireSlot(this.slotRoot,this.settings.maxConcurrency,queueSignal);
      row.started_at=new Date().toISOString();row.status='starting';await this.audit(parent,row);
      timer=setTimeout(()=>row.controller.abort(new Error('LUNA_RUN_TIMEOUT')),this.settings.runTimeoutMs);
      const provider=await this.provider(row.model);
      run=await this.wireContext.run(row,()=>provider.start({parent,prompt:[{type:'text',text:task}],label:'Luna worker',signal:row.controller.signal}));
      row.backend_child_id=String(run.id);row.startup_ms=Date.now()-Date.parse(row.started_at);row.status='running';await this.audit(parent,row);
      const aborted=new Promise((_,reject)=>{const stop=()=>reject(new Error('LUNA_RUN_ABORTED'));if(row.controller.signal.aborted)stop();else row.controller.signal.addEventListener('abort',stop,{once:true});});
      const result=await Promise.race([run.result,aborted]);row.output=result.output;row.stop_reason=result.stopReason;
      row.status=result.stopReason==='completed'?'completed':'failed';
      if(row.status==='failed')row.error='Luna unavailable';
    }catch(e) {row.status=row.controller.signal.aborted?'cancelled':'failed';row.error='Luna unavailable';row.error_code=row.controller.signal.aborted?'LUNA_RUN_TIMEOUT_OR_CANCELLED':'LUNA_PROVIDER_OR_QUEUE_FAILED';
      row.detail_code=/^[A-Z_]+$/.test(e?.code??e?.message??'')?e.code??e.message:null;}
    finally {
      clearTimeout(timer);
      try{await run?.dispose();}catch{row.status='failed';row.error='Luna unavailable';row.error_code='LUNA_TEARDOWN_FAILED';}
      await lease?.release();
      const at=new Date().toISOString();if(row.status==='completed')row.finished_at=at;else row.failed_at=at;
      row.duration_ms=Date.now()-began;
      await this.audit(parent,row);
      if(background&&this.notify&&this.ctx.agents?.get(parent.session.id)===parent)parent.followup(createUserMessage({content:[{type:'text',text:JSON.stringify(this.facts(row,true))}],
        source:{kind:'subagent-settled',senderSessionId:row.child_id,parentSessionId:row.parent_session,ownerLifeId:row.parent_life,form:'notice'}}));
    }
    return this.facts(row,true);
  }
  async results(parent,{child_id}={}) {
    const owner=this.owner(parent);
    const rows=[...this.rows.values()].filter(r=>r.parent_session===String(parent.session.id)&&r.parent_life===owner.lifeId);
    // Sidecars preserve full output without introducing unknown Harness event types.
    const directory=this.resultDirectory(owner.lifeId,String(parent.session.id)),saved=new Map();
    let files=[];try{files=await readdir(directory);}catch(e){if(e.code!=='ENOENT')throw e;}
    for(const file of files.filter(f=>/^[0-9a-f-]{36}\.json$/.test(f))){
      const row=JSON.parse(await readFile(join(directory,file),'utf8'));
      if(row.parent_life===owner.lifeId&&row.parent_session===String(parent.session.id)){
        if(['queued','starting','running'].includes(row.status))try{process.kill(row.worker_pid,0);}catch(e){if(e.code==='ESRCH'){row.status='failed';row.error='Luna unavailable';row.error_code='LUNA_HOST_INTERRUPTED';}}
        saved.set(row.child_id,row);
      }
    }
    for(const row of rows)saved.set(row.child_id,this.facts(row,true));
    if(child_id){const row=saved.get(child_id);if(!row||row.parent_life!==owner.lifeId||row.parent_session!==String(parent.session.id))throw new Error('SUBAGENT_NOT_VISIBLE');return row;}
    return {agents:[...saved.values()].filter(r=>r.parent_life===owner.lifeId&&r.parent_session===String(parent.session.id))};
  }
  async dispose(){for(const row of this.rows.values())if(['queued','starting','running'].includes(row.status))row.controller.abort();await Promise.allSettled([...this.pending]);}
}
export function registerRouterTools(ctx,router,{codexAlias=false,deepseekAlias=false}={}) {
  const add=(toolName,forced)=>ctx.tools.register(defineTool({name:toolName,description:capabilityText,
    parameters:{prompt:str,task:str,description:str,provider:str,model:str,run_in_background:{type:'boolean'}},output:textOutput,isConcurrencySafe:()=>true,
    execute:(args,exec)=>router.start(exec.agent,{...args,...forced},exec.signal)}));
  add('subagent');if(codexAlias)add('subagent_codex',{provider:'codex'});if(deepseekAlias&&router.settings.deepseekEnabled===true)add('subagent_deepseek',{provider:'deepseek'});
  ctx.tools.register(defineTool({name:'subagent_results',description:'Read only this parent Session’s delegated workers, full output, exact backend model and lifecycle. Works for Luna after Host restart; DeepSeek uses native list_agents/send_message.',parameters:{child_id:str},output:textOutput,isConcurrencySafe:()=>true,execute:(args,exec)=>router.results(exec.agent,args)}));
  ctx.tools.register(defineTool({name:'subagent_cancel',description:'Cancel your own queued/running Luna child. DeepSeek uses interrupt_agent.',parameters:{child_id:{...str,required:true}},output:textOutput,
    execute:async(args,exec)=>{await router.results(exec.agent,args);const row=router.rows.get(args.child_id);if(!row)throw new Error('SUBAGENT_NOT_LIVE');row.controller.abort();return {accepted:true,child_id:args.child_id};}}));
  ctx.systemPrompt.section({name:'life:default-luna',order:81,interpolate:false,text:capabilityText});
}
export async function loadSettings(){return JSON.parse(await readFile(new URL('./settings.json',import.meta.url),'utf8'));}
export async function apply(ctx,config={}) {
  const settings={...await loadSettings(),...config};
  const router=new AgentRouter(ctx,settings,{ownerFor:parent=>{
    const ownership=ctx.get('multiLifeOwnership');if(ownership)return ownership.contexts.forAgent(parent);
    throw new Error('SUBAGENT_TRUSTED_OWNER_REQUIRED');
  }});
  registerRouterTools(ctx,router,{codexAlias:true,deepseekAlias:true});ctx.provide('lifeSubagentRouter',router);ctx.effect(()=>()=>router.dispose(),'Luna router lifecycle');
}
