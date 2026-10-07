import {mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {loadSettings} from './router.mjs';
import {connectWorker} from '../multi-life/supervisor/client.mjs';
import {worldSnapshot as snapshot,workerLayout as layout,migrationRoot} from '../multi-life/supervisor/deployment.mjs';
import {findSessionPath} from '../multi-life/supervisor/acceptance-tools.mjs';
const report=resolve(import.meta.dirname,'../../../reports/luna-default-20261006');
const mode=process.argv[2],label=process.argv[3]??'newlife';
const life=Object.values(snapshot().lives).find(m=>label==='persona'?m.kind==='legacy':m.kind!=='legacy');
if(!life)throw new Error('EXACT_LIFE_REQUIRED');
await mkdir(report,{recursive:true});
const file=resolve(report,label+'-live.json');
if(mode==='switch-check') {
 const row=JSON.parse(await readFile(file,'utf8')),client=await connectWorker(life.lifeId);
 if(row.life_id!==life.lifeId||row.session_id===life.authoritySessionId)throw new Error('EXACT_TEST_REQUIRED');
 const requestId=randomUUID();
 const text=`用户追加要求已发布：普通子 Agent 默认 Luna，DeepSeek 子 Agent 开关已关闭（保留实现，你理论上可自主改开关；本次验收不要改）。继续在本测试 Session 做只读验收：
1. 只调用一次普通 subagent，provider="deepseek"，task="只计算2*3，不用任何工具"，验证明确拒绝 DEEPSEEK_SUBAGENTS_DISABLED；不要绕过、不重试、不改文件。
2. 调用一次 subagent_results（不填 child_id），核对刚才本 Session 完成的 Luna 结果在 Host 重载后仍可读取，不包含别的生命或 Session。报告实际模型/身份/结果。
${label==='newlife'?'3. 再调用一次普通 life_delegate（省略provider/model，run_in_background=true），task="标记delegate-second-batch：计算29*31；返回标记和Host父life_id；不调用工具不读写文件"。先自己报告parent继续：77，然后等原父Session完成通知核对真实输出。':'3. 不需另派 Luna，本次只核对开关与持久结果。'}
不要发 Room 消息，不改 Core、Memory、Vault、便签和文件；如协议需要请给真实 ACK。`;
 row.switch_check={request_id:requestId,text,submitted_at:new Date().toISOString()};await writeFile(file,JSON.stringify(row,null,2));
 const receipt=await client('/prompt',{method:'POST',input:life.kind==='legacy'?{sessionId:row.session_id,requestId,text,mode:'queue'}:{session_id:row.session_id,request_id:requestId,text}});
 row.switch_check.receipt=receipt;await writeFile(file,JSON.stringify(row,null,2));console.log(JSON.stringify({session_id:row.session_id,receipt}));
}else if(mode==='retry') {
 const row=JSON.parse(await readFile(file,'utf8')),client=await connectWorker(life.lifeId);
 if(row.life_id!==life.lifeId||row.session_id===life.authoritySessionId)throw new Error('EXACT_EXISTING_TEST_SESSION_REQUIRED');
 const requestId=randomUUID(),text='继续本次默认路由测试：控制侧已修复启动前 owner 检查把隔离目录代理误认成父 Agent 的问题。此前失败保持失败，不当成功。请在同一个测试活动重新执行以下原任务，只提交一次新批次。\n'+row.text;
 row.retries??=[];row.retries.push({request_id:requestId,submitted_at:new Date().toISOString()});await writeFile(file,JSON.stringify(row,null,2));
 const receipt=await client('/prompt',{method:'POST',input:life.kind==='legacy'?{sessionId:row.session_id,requestId,text,mode:'queue'}:{session_id:row.session_id,request_id:requestId,text}});
 console.log(JSON.stringify({session_id:row.session_id,request_id:requestId,receipt}));
}else if(mode==='submit') {
 const client=await connectWorker(life.lifeId),sessionId=randomUUID(),requestId=randomUUID(),nonce=label+'-'+randomUUID().slice(0,8);
 const title=label==='persona'?'Luna默认路由验收':'Luna默认与四路并发验收';
 const created=await client(life.kind==='legacy'?'/life/test-session':'/test-session',{method:'POST',input:{session_id:sessionId,title}});
 if(!created.created||created.session_id!==sessionId||sessionId===life.authoritySessionId)throw new Error('EXACT_NEW_TEST_SESSION_REQUIRED');
 const tasks=label==='persona'?[[23,29]]:[[23,29],[37,41],[13,17],[17,19]];
 const text=`用户授权的独立功能验收：普通 subagent 的默认 Luna 路由${label==='newlife'?'及四路并发':''}。本次 Session 是测试活动，保留父生命体 owner，不能冒称日常主线。不要发 Room 消息，不改文件、Core、便签、Memory 或 Vault。
请你自己调用普通 subagent，完全省略 provider 和 model 字段，run_in_background=true。${tasks.length===4?'同一 assistant 消息中并发提交下面四个调用。':'提交下面一个调用。'}每个 prompt 只给对应的小任务、标记，并要求不读写文件、不调用工具，返回标记、乘法结果及 Host 给的父 life_id（如看得到）。任务：${tasks.map(([a,b],i)=>`${nonce}-${i+1}：计算 ${a}*${b}`).join('；')}。
创建后不要等待 worker，也不要自己替 worker 回答：先自己计算 7*11 并报告“parent继续：77”与实际 child_id，表明父活动可以继续。子结果通过原父 Session 的完成通知回来后，再核对并报告各项真实结果。可用 subagent_results 检查状态；不要高频轮询，不需要另一个人点醒你。若生命体的本轮协议要求 ACK，请按真实工具约定执行。`;
 const row={life_id:life.lifeId,session_id:sessionId,request_id:requestId,title,nonce,tasks,text,created_at:new Date().toISOString()};
 await writeFile(file,JSON.stringify(row,null,2));
 console.log(JSON.stringify({created:true,life_id:life.lifeId,session_id:sessionId,title,nonce}));
 // Legacy prompts use native queue admission so this request does not wait
 // for a model turn's long response. The exact Session/request is durable.
 const receipt=await client('/prompt',{method:'POST',input:life.kind==='legacy'?{sessionId,requestId,text,mode:'queue'}:{session_id:sessionId,request_id:requestId,text}});
 row.receipt=receipt;await writeFile(file,JSON.stringify(row,null,2));console.log(JSON.stringify(receipt));
}else if(mode==='inspect') {
 const row=JSON.parse(await readFile(file,'utf8'));
 const root=life.kind==='legacy'?resolve(migrationRoot,'runtime/native_dsh/home/sessions'):layout(life.lifeId).session_root;
 const path=await findSessionPath(root,row.session_id),records=(await readFile(path,'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 // Only this newly created test Session is opened. No reasoning is exported.
 const selected=records.filter(r=>['tool/call','tool/result','subagent/route','subagent/route-result','turn/end','agent/error','assistant/message'].includes(r.type));
 const safe=selected.map(r=>r.type==='assistant/message'?{...r,data:{message:{content:r.data.message?.content?.filter(b=>b.type==='text')}}}:r);
 const settings=await loadSettings(),directory=resolve(settings.protectedRoot,'subagent-audit',createHash('sha256').update(row.life_id+'\0'+row.session_id).digest('hex'));
 let results=[];try{results=await Promise.all((await readdir(directory)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(resolve(directory,f),'utf8'))));}catch(e){if(e.code!=='ENOENT')throw e;}
 await writeFile(resolve(report,label+'-events.json'),JSON.stringify({path,life_id:row.life_id,session_id:row.session_id,events:safe,results},null,2));
 console.log(JSON.stringify({session_id:row.session_id,tools:selected.filter(r=>r.type==='tool/call').slice(-10).map(r=>({seq:r.seq,name:r.data.name,args:r.data.arguments})),
  results:results.map(({output,...r})=>({...r,text:output?.filter(b=>b.type==='text').map(b=>b.text)})),
  ends:selected.filter(r=>r.type==='turn/end').map(r=>r.data),errors:selected.filter(r=>r.type==='agent/error').map(r=>r.data),
  text:safe.filter(r=>r.type==='assistant/message').slice(-3).map(r=>r.data.message)}));
}else throw new Error('submit or inspect');
