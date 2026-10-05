// Small main-Host seam. The independent watchdog and recovery Agent live elsewhere.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {inheritStateBoardRequest} from '../digital-life/state-board.mjs';
import {calibratedPressure} from '../author-pressure.mjs';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {toolPairingBalancedBefore,toolPairingBalancedAfter,compactCheckpointSource} from '@deepseek-ai/dsh-compaction';
import {stateRoot,incidents,sha,recentFailures} from './diagnostics.mjs';
export async function mountMainRecovery(ctx,{root=stateRoot,workspace,primary}) {
  await mkdir(root,{recursive:true});
  const modePath=resolve(root,'main-mode.json');
  const probeModes=new Map();
  async function mode(){try{return JSON.parse(await readFile(modePath,'utf8'));}catch(e){if(e.code==='ENOENT')return {mode:'normal'};throw e;}}
  const user=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}});
  const register=(name,description,parameters,execute)=>ctx.tools.register(defineTool({name,description,parameters,
    output:{schema:{type:'json'},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute}));
  ctx.on('llm/stream',(options,next)=>(async function*(){
    if(options.purpose?.startsWith('recovery-adjusted:')||options.purpose==='self-author-capacity-view'){yield* next();return;}
    const current=await mode(), id=String(options.sessionId), probe=probeModes.get(id);
    const light=probe?.light||(id===primary&&current.mode==='light');
    let adjusted={...options};
    if(light&&options.purpose!=='compaction') {
      const session=ctx.sessions.get(id), events=Array.from({length:session.seq},(_,seq)=>session.eventAt(seq));
      const start=events.findLast(e=>e.type==='turn/start');
      const messages=session.surface.nodes.filter(seq=>seq>=(start?.seq??0))
        .map(seq=>session.deriveEventMessage(session.eventAt(seq))).filter(m=>m&&m.role!=='system');
      const core=await readFile(resolve(workspace,'persona-core.md'),'utf8');
      const agents=await readFile(resolve(workspace,'AGENTS.md'),'utf8');
      adjusted.messages=[{role:'system',content:[{type:'text',text:core+'\n\n'+agents+
        '\n你现在是人格的轻量恢复模式。身份仍来自上面的当前核心原文。这次请求只加载当前一轮，不加载旧对话、长期记忆或待处理活动。原始对话全部保留。先 recovery_diagnostics 理解故障，必要时 session_event_read 查证。修改有验证和回退，不能把恢复成功当做未执行任务已完成。不要重复已执行的文件或外部操作。'}]},...messages];
      adjusted.toolHistory=undefined;
    }
    if(probe){adjusted.tools=[];adjusted.maxTokens=512;adjusted.reasoningEffort='off';}
    if(light||probe){adjusted.purpose='recovery-adjusted:'+(probe?.preview?'wire-preview':options.purpose??'agent');inheritStateBoardRequest(adjusted,options);yield* ctx.llm.stream(adjusted);return;}
    yield* next();
  })(),{prepend:true});
  register('recovery_diagnostics','读取本次运行故障的真实脱敏详情、当前轻量模式与原始事件定位；不调用模型。',{},async(_a,exec)=>({
    mode:await mode(),incidents:await incidents({sessionId:String(exec.agent.session.id),root}),recentFailures:await recentFailures(root),
    originalHistoryPreserved:true,standby:resolve(import.meta.dirname,'standby.mjs')}));
  register('recovery_checkpoint','由人格本人写较短的接续检查点替换本Session旧上下文的可见表示。原始事件完整保留；只在当前正常工具步骤执行，并保留当前一轮。须先阅读原文，不凭空写记忆。',
    {checkpoint:{type:'string',required:true}},async(args,exec)=>{
      if(!args.checkpoint?.trim()||args.checkpoint.length>60000)throw Error('Invalid recovery checkpoint');
      const session=exec.agent.session,events=Array.from({length:session.seq},(_,seq)=>session.eventAt(seq));
      const start=events.findLast(e=>e.type==='turn/start'),end=events.findLast(e=>e.type==='turn/end');
      if(!start||(end&&end.seq>start.seq))throw Error('A live native tool step is required');
      // A surface span is positional and must include *every* node between its
      // endpoints, including historic system snapshots. Preserve the current
      // leading system/core and the current turn, never filter holes into a span.
      const nodes=session.surface.nodes;
      const from=session.eventAt(nodes[0])?.type==='system/message'?1:0;
      const current=nodes.findIndex((seq,index)=>index>=from&&seq>=start.seq);
      const selected=nodes.slice(from,current<0?nodes.length:current);
      if(!selected.length)throw Error('No older context to replace');
      if(!toolPairingBalancedBefore(session,selected[0])||!toolPairingBalancedAfter(session,selected.at(-1)))throw Error('Unbalanced old tool range');
      const sourceHash=sha(JSON.stringify(selected.map(seq=>session.eventAt(seq))));
      if(ctx.tokenMeter.estimateMessage(user(args.checkpoint))>=ctx.tokenMeter.measure(session).nodes.filter(n=>selected.includes(n.seq)).reduce((s,n)=>s+n.tokens,0))throw Error('Checkpoint must be shorter');
      const id=randomUUID(),lifecycle={compactionId:id,turn:start.data.turn};
      const begin=session.append('compaction/start',lifecycle);
      const summary=session.append('compaction/summary',{...lifecycle,summary:[{type:'text',text:args.checkpoint}],
        shadowedRange:{start:selected[0],end:selected.at(-1)},shadowedSeqs:selected,
        provider:'self-authored',model:'persona-recovery'});
      session.append('user/message',createUserMessage({content:[{type:'text',text:args.checkpoint}],source:compactCheckpointSource(id)}),{
        surfaceOp:{op:'replace',startSeq:selected[0],endSeq:selected.at(-1)},sourceEventSeqs:[begin.seq,summary.seq,...selected]});
      session.append('compaction/end',lifecycle);await ctx.sessions.flush(session);
      return {committed:true,compactionId:id,sourceHash,originalEventsPreserved:true,checkpointAuthorSessionId:String(session.id)};
    });
  register('recovery_resume','主对话人格在自己成功提交检查点且容量足够后，切回正常模式。核对原生已完成写回与容量；活动对话不能切换主对话。',{},async(_a,exec)=>{
    const agent=exec.agent,session=agent.session;
    if(String(session.id)!==primary)throw Error('Only the primary Session author can resume the primary');
    const original=await readFile(modePath,'utf8'),current=JSON.parse(original);
    if(current.mode!=='light')return {mode:current.mode,changed:false};
    const events=[...session.ownEvents()],summary=events.findLast(e=>e.type==='compaction/summary'&&e.data.provider==='self-authored'&&e.time>=Date.parse(current.updatedAt??0));
    if(!summary||!events.some(e=>e.type==='compaction/end'&&e.data.compactionId===summary.data.compactionId&&!e.data.error))throw Error('Commit your own checkpoint successfully before leaving light mode');
    if(ctx.get('personaCompaction')?.authorPressure?.state(agent).pending)throw Error('Author checkpoint still pending');
    const header=session.requestHeader()?.config??agent.options,info=await ctx.llm.resolveModelInfo(header.provider,header.model,exec.signal);
    const output=ctx.get('personaCompaction')?.authorPressure?.state(agent).originalMaxTokens??header.maxTokens??info.defaultMaxTokens??0;
    const estimated=calibratedPressure(ctx,session).totalTokens,capacity=info.context?.contextWindow;
    if(!capacity||estimated+output+8192>=capacity*0.85)throw Error('Full context still has insufficient capacity; stay light and write a shorter checkpoint');
    await ctx.sessions.flush(session);
    if(await readFile(modePath,'utf8')!==original)throw Error('Recovery mode changed concurrently; retry after checking diagnostics');
    const record={mode:'normal',reason:'Primary author committed checkpoint '+summary.data.compactionId+' and verified capacity',updatedAt:new Date().toISOString(),sessionId:primary,
      authorSessionId:primary,checkpointSeq:summary.seq,estimatedInput:estimated,outputReserved:output,contextCapacity:capacity};
    const tmp=modePath+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(record)+'\n');await import('node:fs/promises').then(fs=>fs.rename(tmp,modePath));
    return {changed:true,...record,originalHistoryPreserved:true};
  });
  async function status(){
    let standby;try{const v=JSON.parse(await readFile(resolve(root,'watch-state.json'),'utf8'));standby={pid:v.pid,phase:v.phase,workerPid:v.workerPid??null,observedAt:v.observedAt,enabled:v.enabled,lastWorkerExit:v.lastWorkerExit??null};}
    catch(e){if(e.code!=='ENOENT')throw e;standby={phase:'not-started'};}
    return {mode:await mode(),standby,incidents:await recentFailures(root),diagnosticRoot:root};
  }
  const service={mode,status,async command(input){
    if(input.action==='status')return {...await status(),incidents:await incidents({sessionId:input.sessionId??primary,root})};
    if(input.action==='set_mode') {
      if(!['normal','light'].includes(input.mode))throw Error('Unknown recovery mode');
      if(ctx.personaTasks.running().includes(primary))throw Error('Primary is busy; defer mode change');
      const record={mode:input.mode,reason:String(input.reason??'Explicit recovery').slice(0,1000),updatedAt:new Date().toISOString(),sessionId:primary};
      const tmp=modePath+'.tmp';await writeFile(tmp,JSON.stringify(record)+'\n');await import('node:fs/promises').then(fs=>fs.rename(tmp,modePath));return record;
    }
    if(input.action==='probe') {
      // A native fork copies the exact history. The primary receives no test prompt or edits.
      const fork=await ctx.sessionController.fork({sessionId:input.sessionId??primary});
      await ctx.sessionController.rename({sessionId:fork.sessionId,title:'主对话上下文故障复现 '+(input.light?'轻量':'完整')});
      const r=await ctx.sessionController.resolveAgent(fork.sessionId);if('error'in r)throw r.error;
      probeModes.set(String(fork.sessionId),{light:input.light===true,preview:input.preview===true});
      const first=r.agent.session.seq;
      try {
        await ctx.sessionController.prompt({sessionId:fork.sessionId,requestId:randomUUID(),mode:'queue',clientTimeZone:'Asia/Shanghai',
          content:[{type:'text',text:'这是独立的故障复现Session，复制主对话历史以验证请求是否能执行。不要调用工具，不改文件，不继续旧任务。只回复：完整上下文连接成功。'}]},AbortSignal.timeout(90000));
        await r.agent.whenIdle();await ctx.sessions.flush(r.agent.session);
        const events=Array.from({length:r.agent.session.seq-first},(_,i)=>r.agent.session.eventAt(first+i));
        const end=events.findLast(e=>e.type==='turn/end');
        return {sessionId:String(fork.sessionId),state:end?.data.reason.kind,reason:end?.data.reason,
          incidents:await incidents({sessionId:String(fork.sessionId),root}),primaryUnchanged:true};
      }finally{probeModes.delete(String(fork.sessionId));}
    }
    throw Error('Unknown recovery command');
  }};
  ctx.provide('personaRecovery',service);
  return service;
}
