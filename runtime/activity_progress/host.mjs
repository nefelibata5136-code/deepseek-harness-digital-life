import {readFileSync} from 'node:fs';
import {VERSION} from './events.mjs';
const policyPath=new URL('./policy.json',import.meta.url);
export function readPolicy() {
  const p=JSON.parse(readFileSync(policyPath,'utf8'));
  if(typeof p.enabled!=='boolean'||typeof p.selfReports!=='boolean'
      ||!Number.isInteger(p.maxReportCharacters)||p.maxReportCharacters<40||p.maxReportCharacters>300
      ||!Number.isInteger(p.minReportIntervalSeconds)||p.minReportIntervalSeconds<15
      ||!Number.isInteger(p.quietWarningSeconds)||p.quietWarningSeconds<30) throw Error('Invalid activity progress policy');
  return p;
}
export function progressInstruction(policy) {
  return `给正在看界面的用户提供简短进展说明。这是任务沟通，不是内心独白或正式记忆。
用户交办的多步任务，在开始及关键发现/阻碍时，可在本来要调用工具的同一条回复加一行【进展】，说明目的、已确认的发现或下一步；随后照常执行，不能单独发进展就结束任务。
像跟用户说话一样解释大概在忙什么，1–2句话、最多${policy.maxReportCharacters}字，尽量30–70字；不用逐条列工具调用，少用术语和完整路径。不写逐字内部推理、私密内容或没有依据的百分比/完成状态。
保持原有工具计划：不为说明加目录检查、重复读取、读维护技能、查钟或子Agent，不把可并行的独立调用变串行。只在有新事实时写，通常至少隔${policy.minReportIntervalSeconds}秒，不保证固定频率；工具等待由界面显示。单步问答、闲聊、定时醒来和休息无需报告。最后照常完整回答。`;
}
export function mountProgress(ctx) {
  let lastPolicy=readPolicy();
  const settings=()=>{try{return lastPolicy=readPolicy();}catch{return lastPolicy;}};
  ctx.systemPrompt.section({name:'persona:task-progress',order:85,interpolate:false,text:()=>{
    const p=settings(), agent=ctx.agents.currentInitiator();
    if(!p.enabled||!p.selfReports||!agent||ctx.get('personaPrivateVault')?.isSensitive(agent.session))return '';
    const events=[...agent.session.ownEvents()];
    // Native user admission precedes turn/start; a later empty splice must not
    // erase that source. Only messages admitted since the last ended turn count.
    const ended=events.findLast(e=>e.type==='turn/end');
    const inbox=events.findLast(e=>e.type==='agent/inbox/spliced'&&e.seq>(ended?.seq??-1)
      &&e.data?.inserted?.some(m=>m.role==='user'));
    if(!inbox?.data.inserted?.some(m=>m.role==='user'&&m.source?.kind==='user'))return '';
    return progressInstruction(p);
  }});
  ctx.provide('personaProgress',{status:()=>({version:VERSION,...settings()})});
}
