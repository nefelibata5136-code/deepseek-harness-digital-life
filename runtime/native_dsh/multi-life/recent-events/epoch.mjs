// Only the current Session author writes stage memory. Original journal stays intact.
import {createHash} from 'node:crypto';
import {createUserMessage} from '@deepseek-ai/dsh-llm';
import {stableJson} from './store.mjs';
import {renderEventBlock,renderStableRecentEvent} from './render.mjs';
import {recentPolicy,validateRecentPolicy} from './policy.mjs';
import {fail} from '../contracts.mjs';
export const recentEpochPolicy=recentPolicy;
const hash=value=>createHash('sha256').update(stableJson(value)).digest('hex');
const snapshot=(event,lifeId)=>event?.type==='user/message'&&event.data.source?.kind==='life-recent-events'&&event.data.source.lifeId===lifeId;
const checkpoint=(event,lifeId,sessionId)=>event?.type==='user/message'&&event.data.source?.kind==='life-recent-checkpoint'&&event.data.source.lifeId===lifeId&&event.data.source.sessionId===sessionId;
const body=event=>(event?.data?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
export function recentContextState(session,lifeId) {
  const nodes=(session.surface?.nodes??[]).map(seq=>session.eventAt(seq));
  const views=nodes.filter(event=>snapshot(event,lifeId)||checkpoint(event,lifeId,session.id));
  const cp=views.findLast(event=>checkpoint(event,lifeId,session.id));
  // Old coveredEventIds meant all visible history, including omitted bodies.
  // During migration only actually rendered blocks count as seen.
  const seen=new Set(views.flatMap(event=>event.data.source.recentEntries?.map(e=>e.event_id)??[...body(event).matchAll(/^【事件开始 ([^\n]+)】$/gm)].map(match=>match[1])));
  const entries=new Map();for(const event of views)for(const entry of event.data.source.recentEntries??[])entries.set(entry.event_id,entry);
  return {nodes,views,seen,entries,checkpoint:cp,snapshots:views.filter(event=>snapshot(event,lifeId)),cutoffSeq:cp?.data.source.cutoffSeq??0,stageMemory:cp?.data.source.stageMemory??''};
}
export const hasSeen=(view,event)=>event.seq<=view.cutoffSeq||view.seen.has(event.event_id);
async function repair({session,lifeId,cp,flush}) {
  for(const seq of cp.data.source.shadowedViewSeqs??[]) {
    if(!session.surface.nodes.includes(seq))continue;
    const event=session.eventAt(seq);if(!snapshot(event,lifeId)&&!checkpoint(event,lifeId,session.id))fail('RECENT_EPOCH_SCOPE_MISMATCH');
    session.append('user/message',createUserMessage({content:[],source:{kind:'life-recent-epoch-shadow',lifeId,sessionId:session.id,epochId:cp.data.source.epochId}}),
      {surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq,cp.seq]});
  }
  if(flush)await flush(session);
}
export async function advanceRecentEpoch({session,lifeId,events=[],flush,policy=recentPolicy}) {
  policy=validateRecentPolicy({...recentPolicy,...policy});let view=recentContextState(session,lifeId);
  if(view.checkpoint?.data.source.author==='current-session-agent'){await repair({session,lifeId,cp:view.checkpoint,flush});view=recentContextState(session,lifeId);}
  for(const event of events)if(view.seen.has(event.event_id)&&!view.entries.has(event.event_id))view.entries.set(event.event_id,event);
  return {...view,advanced:false,epochId:view.checkpoint?.data.source.epochId??null,policy};
}
export function prepareStageMemory({session,lifeId,policy=recentPolicy}) {
  policy=validateRecentPolicy({...recentPolicy,...policy});const view=recentContextState(session,lifeId),entries=[...view.entries.values()].sort((a,b)=>a.seq-b.seq);
  const size=entries.reduce((sum,event)=>sum+renderEventBlock({lifeId,event}).length,0);
  const legacy=view.views.some(event=>!event.data.source.recentEntries&&event.data.source.author!=='current-session-agent');
  const required=entries.length>=policy.highWaterEvents||size>=policy.highWaterChars||legacy;
  const warning=view.stageMemory.length>=policy.stageMemoryWarnChars;
  if(!required&&!warning)return {required:false,event_count:entries.length,policy,
    stage_memory_warning:false,current_stage_memory:view.stageMemory};
  let keep=Math.min(policy.targetEvents,entries.length),chars=0;
  for(let i=entries.length-1;i>=entries.length-keep;i--){chars+=renderEventBlock({lifeId,event:entries[i]}).length;if(chars>policy.targetChars){keep=Math.max(1,entries.length-i-1);break;}}
  const departing=entries.slice(0,entries.length-keep),retained=entries.slice(entries.length-keep),sourceSeqs=view.views.map(event=>event.seq);
  const checkpointId='recent-epoch-'+hash({lifeId,sessionId:session.id,sourceSeqs,departing:departing.map(e=>e.record_hash??hash(e)),stageMemory:view.stageMemory});
  return {required,stage_memory_warning:warning,checkpoint_id:checkpointId,current_stage_memory:view.stageMemory,
    // Legacy Host extraction is input evidence for the author, never stage memory.
    legacy_context_material:legacy?view.views.filter(event=>!event.data.source.recentEntries&&event.data.source.author!=='current-session-agent').map(body):[],
    departing_events:departing,retained_events:retained,source_seqs:sourceSeqs,policy,event_count:entries.length,
    instruction:'有一批近期事件即将离开近期窗口。请根据自己的需要更新阶段记忆。自由文本、格式与长度由你决定，未来的自己能理解即可。Host 不替你总结，不偷偷截断。仅保留你认为应继续记住的事实、理解或承诺；测试材料不要写进长期记忆。'};
}
export async function commitStageMemory({session,lifeId,checkpointId,text,flush,policy=recentPolicy}) {
  policy=validateRecentPolicy({...recentPolicy,...policy});
  if(typeof text!=='string')fail('STAGE_MEMORY_TEXT_REQUIRED');
  if(text.length>policy.stageMemoryHardChars)fail('STAGE_MEMORY_HARD_LIMIT_REWRITE_REQUIRED');
  // Exact retry is a receipt read, including after a partially flushed shadow transition.
  const current=recentContextState(session,lifeId).checkpoint;
  if(current?.data.source.epochId===checkpointId){if(current.data.source.stageMemory!==text)fail('STAGE_MEMORY_RETRY_CONFLICT');await repair({session,lifeId,cp:current,flush});return {committed:true,checkpoint_id:checkpointId,event_count:current.data.source.recentEntries.length,replayed:true};}
  const plan=prepareStageMemory({session,lifeId,policy});
  if(!plan.checkpoint_id||plan.checkpoint_id!==checkpointId)fail('STAGE_MEMORY_PLAN_CHANGED');
  const entries=plan.retained_events,first=plan.source_seqs[0];if(first===undefined)fail('STAGE_MEMORY_RECENT_CONTEXT_REQUIRED');
  const cutoffSeq=Math.max(recentContextState(session,lifeId).cutoffSeq,...plan.departing_events.map(e=>e.seq));
  const rendered=['【阶段记忆】',text,'【阶段记忆结束】','','【近期发生的事】',...entries.map(event=>renderStableRecentEvent({lifeId,event}))].join('\n\n');
  const cp=session.append('user/message',createUserMessage({content:[{type:'text',text:rendered}],source:{kind:'life-recent-checkpoint',lifeId,sessionId:session.id,epochId:checkpointId,
    author:'current-session-agent',stageMemory:text,recentEntries:entries,coveredEventIds:entries.map(e=>e.event_id),cutoffSeq,shadowedViewSeqs:plan.source_seqs.slice(1),form:'checkpoint'}}),
    {surfaceOp:{op:'replace',startSeq:first,endSeq:first},sourceEventSeqs:plan.source_seqs});
  // Persist the intent before replacing any other view. Crash repair never asks
  // a second summarizer to invent another memory version.
  if(flush)await flush(session);await repair({session,lifeId,cp,flush});
  return {committed:true,checkpoint_id:checkpointId,event_count:entries.length,departed:plan.departing_events.length,stage_memory_chars:text.length};
}
