// Native task catalog. Serialize submissions within a Session, never across conversations.
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {defineTool} from '@deepseek-ai/dsh-tools';
export const inject=['sessionController','sessionQuery','sessions','tools'];
export function createTurnAdmission() {
  let owner=null;
  const queue=[];
  let disposed=false;
  function grant(item) {
    owner=item.sessionId;
    let released=false;
    item.accept({release(){if(released)return;released=true;owner=null;const next=queue.shift();if(next)grant(next);}});
  }
  return {get owner(){return owner;},acquire(sessionId){return new Promise((accept,reject)=>{
    if(disposed)return reject(new Error('Host admission disposed'));
    const item={sessionId,accept,reject};if(owner===null)grant(item);else queue.push(item);
  });},dispose(){disposed=true;for(const item of queue.splice(0))item.reject(new Error('Host admission disposed'));}};
}
export function apply(ctx,config) {
  const primary=process.env.DL_SESSION_ID;
  const cwd=resolve(config.workspace);
  const locks=new Map();
  const running=new Set();
  const admission={acquire(id){
    if(!locks.has(id))locks.set(id,createTurnAdmission());
    return locks.get(id).acquire(id);
  },dispose(){for(const lock of locks.values())lock.dispose();}};
  ctx.on('session/event',(session,event)=>{
    if(event.type==='turn/start')running.add(String(session.id));
    if(event.type==='turn/end')running.delete(String(session.id));
  });
  ctx.provide('personaTurnAdmission',admission);
  ctx.effect(()=>()=>admission.dispose(),'shared Persona workspace admission');
  const records=async()=> (await ctx.sessionQuery.listSessions()).filter(r=>resolve(r.header.cwd??'')===cwd
    && (r.header.delegationDepth??0)===0 && !r.header.isSeeded);
  const accepts=async id=>id===primary||(await records()).some(r=>r.header.id===id);
  const tasks={accepts,running:()=>[...running],allRecords:async()=> (await ctx.sessionQuery.listSessions()).filter(r=>resolve(r.header.cwd??'')===cwd),async list(){
    const source=await records();
    const titles=await ctx.sessionQuery.readTitleSnapshots(source.map(r=>r.header.id));
    return source.map((r,index)=>({sessionId:r.header.id,primary:r.header.id===primary,
      title:r.header.id===primary?'人格主对话':titles[index]?.value?.title?.title??'新任务',
      role:r.header.id===primary?'consciousness-seat':'activity',authoritative:r.header.id===primary,
      createdAt:r.header.createdAt,live:r.live})).sort((a,b)=>Number(b.primary)-Number(a.primary)||b.createdAt-a.createdAt);
  },async create({sessionId=randomUUID(),title='新任务'}={}) {
    if(!/^[a-f0-9-]{36}$/i.test(sessionId)||typeof title!=='string'||!title.trim()||title.length>120)
      throw new Error('Invalid task identity or title');
    const existing=(await ctx.sessionQuery.listSessions()).find(r=>r.header.id===sessionId);
    if(existing) {if(!await accepts(sessionId))throw new Error('Session belongs to another workspace');return {sessionId,existing:true};}
    await ctx.sessionController.create({sessionId,cwd});
    await ctx.sessionController.rename({sessionId,title:title.trim()});
    const result=await ctx.sessionController.resolveAgent(sessionId);
    if('error' in result)throw result.error;
    await ctx.sessions.flush(result.agent.session);
    return {sessionId,title:title.trim(),existing:false};
  }};
  ctx.provide('personaTasks',tasks);
  for(const [name,description,parameters,execute] of [
    ['task_list','列出人格同一工作区里的任务对话；不会唤醒模型或复制记忆。',{},()=>tasks.list()],
    ['task_create','新建人格的一项并行活动，结果投递给意识席位。活动没有独立身份、正式发言权或状态写权限。只建空任务，不自动运行。',
      {title:{type:'string',required:true}},args=>tasks.create({title:args.title})],
  ])ctx.tools.register(defineTool({name,description,parameters,output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute}));
}
