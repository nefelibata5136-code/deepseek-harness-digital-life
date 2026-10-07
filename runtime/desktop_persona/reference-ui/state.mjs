// Read-only projection of existing evidence; no new diary, inferred mood or writer.
import {open,readFile,readdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {identity,hostRequest} from '../transport.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const native=resolve(root,'runtime/native_dsh');
const clean=value=>String(value??'').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g,'[凭据已隐藏]');
const date=value=>new Date(value).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const cache={path:null,offset:0,board:null,self:null,calls:new Map(),changes:[],actions:[],turns:new Map(),serial:Promise.resolve()};
async function sessionPath(id){
 for(const entry of await readdir(resolve(native,'home/sessions'),{withFileTypes:true})){
  if(!entry.isDirectory()||entry.isSymbolicLink())continue;
  const path=resolve(native,'home/sessions',entry.name,id,'session.v4.jsonl');
  try{const handle=await open(path);await handle.close();return path;}catch(e){if(e.code!=='ENOENT')throw e;}
 }throw Error('Native Session not found');
}
const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
function accept(event){
 const d=event.data??{},time=event.time;
 if(event.type==='system/message'&&d.message?.source?.producer==='digital-life-state-board'){
  cache.board={...d.message.source.board,observedAt:time};
  // A successful update after a request board is more recent than that board.
  if(!cache.self||Number(cache.self.author?.at??0)<=Number(time))cache.self=cache.board.self;
 }
 if(event.type==='turn/start')cache.turns.set(d.turn,{start:time,end:null});
 if(event.type==='turn/end'&&cache.turns.has(d.turn))cache.turns.get(d.turn).end=time;
 if(event.type==='tool/call')cache.calls.set(String(d.callId),{name:d.name,args:parse(d.arguments)??{},time,seq:event.seq});
 if(event.type!=='tool/result')return;
 const message=d.message,callId=String(message?.toolCallId??message?.source?.callId??d.callId),call=cache.calls.get(callId);
 if(!call)return;cache.calls.delete(callId);
 const content=(message.content??[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
 if(call.name==='digital_life_state_update'&&!message.isError){
  const value=parse(content),change=value?.digitalLifeStateChange;
  if(value?.updated===true&&change?.provenance?.callId===callId){
   cache.self=change.state;
   const text=change.state.activity!==change.before?.activity?'活动更新：'+change.state.activity:change.state.desired_reasoning_effort!==change.before?.desired_reasoning_effort?'思考档位调整为 '+change.state.desired_reasoning_effort:'更新了自己的状态';
   cache.changes.push({id:callId,text:clean(text),time,icon:'🌱',source:'native successful state update'});
  }
 }
 if(call.name==='life_mental_write'&&!message.isError)cache.changes.push({id:callId,text:call.args.text?'写下了此刻的心境':'清空了心境',time,icon:'✏️',source:'native mental write'});
 if(!['digital_life_state_read','life_status','budget_status','life_pending_list','task_list'].includes(call.name))cache.actions.push({id:callId,name:call.name,args:call.args,time:call.time,finishedAt:time,seq:call.seq,status:message.isError?'error':'completed'});
}
async function update(id){
 cache.path??=await sessionPath(id);
 const handle=await open(cache.path);
 try{
  const {size}=await handle.stat();if(size<cache.offset)throw Error('Native log shrank; projection requires review');
  if(size===cache.offset)return;
  const buffer=Buffer.alloc(size-cache.offset);const {bytesRead}=await handle.read(buffer,0,buffer.length,cache.offset);
  // Process only complete durable lines; leave incomplete UTF-8/tail for next poll.
  const end=buffer.subarray(0,bytesRead).lastIndexOf(10);if(end<0)return;
  const lines=buffer.subarray(0,end+1).toString('utf8').split('\n');
  for(let i=0;i<lines.length-1;i++){const event=parse(lines[i]);if(!event)throw Error('Invalid native log record');accept(event);if(i%500===0)await yieldEventLoop();}
  cache.offset+=end+1;
 }finally{await handle.close();}
}
function actionView(row){
 const name=row.name.toLowerCase(),args=row.args;
 let title='使用工具',sub=row.name,icon='article-icon.png',category='work';
 if(name.includes('bluesky')){title='浏览 Bluesky';sub='查看网络中的动态';icon='bluesky-icon.png';category='browse';}
 else if(name.includes('github')||String(args.url??'').includes('github.com')){title='查看 GitHub';sub='浏览项目与资料';icon='github-icon.png';category='browse';}
 else if(name.includes('browser')||name.includes('fetch')||name.includes('search')){title='浏览世界';sub='查阅网页与资料';icon='article-icon.png';category='browse';}
 else if(name.includes('memory')){title='整理记忆';sub='查看或整理已有记录';icon='article-icon.png';category='memory';}
 else if(['read','read_source','write','edit'].includes(name)){title=({read:'读取文件',read_source:'读取资料',write:'写入文件',edit:'修改文件'})[name];sub=String(args.path??args.file_path??'').replaceAll('\\','/').split('/').at(-1)||'工作区中的文件';}
 else if(name.includes('subagent')){title='委派任务';sub=args.description??args.label??'处理独立任务';}
 else if(name==='terminal'){title='执行命令';sub='运行本地任务';}
 else if(name==='context_compact'){title='整理对话';sub='接续已有上下文';icon='chat-icon.png';}
 else if(name.startsWith('life_')||name.startsWith('digital_life_')){title='更新生活状态';sub='保存本人的选择';icon='chat-icon.png';}
 if(row.status==='error')sub='执行未完成 · '+sub;
 return {id:row.id,title,sub:clean(sub),time:row.time,icon,status:row.status,category};
}
export async function readReferenceState(){
 const id=await identity();
 const operation=cache.serial.then(()=>update(id));cache.serial=operation.catch(()=>{});await operation;
 const response=await hostRequest('GET','/status');if(response.status!==200||!response.value.ready)throw Error('Host unavailable');
 const status=response.value,now=Date.now(),today=date(now),running=status.activeSessionIds?.includes(id)===true;
 let mental=null;try{mental=JSON.parse(await readFile(resolve(native,'digital-life/protected/persona/mental.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!mental?.text||mental.expiresAt&&Date.parse(mental.expiresAt)<=now||mental.sessionId!==id)mental=null;
 const recent=[...cache.actions,...[...cache.calls].map(([callId,call])=>({id:callId,...call,status:'running'}))].sort((a,b)=>b.time-a.time).slice(0,4).map(actionView);
 const todayActions=cache.actions.filter(a=>date(a.time)===today).map(actionView);
 const counts={bluesky:0,github:0,articles:0};
 for(const a of todayActions)if(a.status==='completed'){if(a.icon==='bluesky-icon.png')counts.bluesky++;else if(a.icon==='github-icon.png')counts.github++;else if(a.category==='browse')counts.articles++;}
 // Primary native turn intervals, clipped at today's boundary. Rest is unknown.
 const startOfDay=Date.parse(new Date(now).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})+'T00:00:00+08:00');
 const intervals=[...cache.turns.values()].map(t=>({start:Math.max(t.start,startOfDay),end:Math.min(t.end??(running?now:t.start),now)})).filter(t=>t.end>t.start).sort((a,b)=>a.start-b.start);
 let duration=0,last=0;for(const t of intervals){duration+=Math.max(0,t.end-Math.max(t.start,last));last=Math.max(last,t.end);}
 return {version:1,sessionId:id,observedAt:now,ready:true,running,
  self:{activity:cache.self?.activity??null,activityStartedAt:cache.self?.activityStartedAt??null,residentState:cache.self?.resident_state??null,desiredEffort:cache.self?.desired_reasoning_effort??null,author:cache.self?.author??null},
  request:{actualEffort:cache.board?.facts?.actualEffort??null,observedAt:cache.board?.observedAt??null,supportedEfforts:cache.board?.facts?.supportedEfforts??[]},
  mental:mental?{text:clean(mental.text),writtenAt:mental.writtenAt,sessionId:mental.sessionId,callId:mental.callId}:null,
  changes:cache.changes.slice(-3).reverse(),recent,world:counts,
  rhythm:{nativeTurnMs:duration,restMs:null,source:'primary native turn intervals',since:startOfDay},
  source:{activity:'successful primary state update or request state board',effort:'latest primary request state board',mental:'unexpired own mental.json',recent:'native tool call/result',rhythm:'primary native turn start/end'},
  unavailable:['interruptibility','personal concerns count','rest duration']};
}
