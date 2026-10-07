import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {connectWorker} from '../multi-life/supervisor/client.mjs';
import {worldSnapshot,workerLayout,migrationRoot} from '../multi-life/supervisor/deployment.mjs';
import {findSessionPath} from '../multi-life/supervisor/acceptance-tools.mjs';
import {loadSettings} from './router.mjs';
const report=resolve(import.meta.dirname,'../../../reports/luna-full-access-20261007');await mkdir(report,{recursive:true});
const mode=process.argv[2],label=process.argv[3];if(!['persona','newlife'].includes(label))throw new Error('EXACT_LIFE_LABEL_REQUIRED');
const life=Object.values(worldSnapshot().lives).find(m=>label==='persona'?m.kind==='legacy':m.kind!=='legacy');
const file=resolve(report,label+'-live.json');
if(mode==='submit'){
 const client=await connectWorker(life.lifeId),sessionId=randomUUID(),requestId=randomUUID();
 const title='Luna文本读写与终端完全访问验收';
 const created=await client(life.kind==='legacy'?'/life/test-session':'/test-session',{method:'POST',input:{session_id:sessionId,title}});
 assert(created.created&&created.session_id===sessionId&&sessionId!==life.authoritySessionId);
 const area=resolve(life.deployment.workspace,'development/experiments','luna-full-access-'+sessionId);await mkdir(area,{recursive:true});
 const input={nonce:randomUUID(),a:label==='persona'?53:67,b:29};
 const inputPath=resolve(area,'input.json'),outputPath=resolve(area,'output.json');await writeFile(inputPath,JSON.stringify(input));
 const task=`用户授权完全访问功能验收。真实用 shell（PowerShell Get-Content 或等价命令）读取这个文本JSON：${inputPath}。不要用图像read/view，不要猜文件内容。计算文件中a+b；用shell写出这个输出文件：${outputPath}。输出JSON字段必须为nonce（照文件原样）、sum（a+b）、life_id（Host父life_id）、cwd（实际当前目录）。再用shell读回核对。只操作这两个指定文件，不改Core/Memory/Vault、不输出凭据、不发外部消息。返回真实操作结果与工具名。`;
 const text=`本次是用户授权的独立功能验收Session。Luna已设为完全访问（danger-full-access/approval never），shell已启用，从你的工作目录运行。请调用一次普通subagent，省略provider/model，run_in_background=true，原样下发下面任务；不要由你代做文件读写，不要加“不得访问文件”或“只读”限制。提交后报告child_id，继续父活动；完成通知到达后用subagent_results核对。不要发Room消息，不改Core/Memory/Vault。如协议需要给真实ACK。
任务：${task}`;
 const row={life_id:life.lifeId,session_id:sessionId,request_id:requestId,title,input,input_path:inputPath,output_path:outputPath,text,created_at:new Date().toISOString()};
 await writeFile(file,JSON.stringify(row,null,2));
 const receipt=await client('/prompt',{method:'POST',input:life.kind==='legacy'?{sessionId,requestId,text,mode:'queue'}:{session_id:sessionId,request_id:requestId,text}});
 row.receipt=receipt;await writeFile(file,JSON.stringify(row,null,2));console.log(JSON.stringify({created:true,session_id:sessionId,receipt}));
}else if(mode==='inspect'){
 const row=JSON.parse(await readFile(file,'utf8')),settings=await loadSettings();
 const directory=resolve(settings.protectedRoot,'subagent-audit',createHash('sha256').update(row.life_id+'\0'+row.session_id).digest('hex'));
 let results=[];try{results=await Promise.all((await readdir(directory)).filter(f=>f.endsWith('.json')).map(async f=>JSON.parse(await readFile(resolve(directory,f),'utf8'))));}catch(e){if(e.code!=='ENOENT')throw e;}
 // Inspect saved evidence even when user shutdown forbids live execution.
 // Reading the deployment's session_root does not start or contact a worker.
 const deployments=JSON.parse(await readFile(resolve(process.env.DL_WORLD_ROOT || resolve(migrationRoot,'.local/world'), 'supervisor/deployments.json'),'utf8'));
 const root=deployments.workers[life.lifeId].session_root;
 const path=await findSessionPath(root,row.session_id),records=(await readFile(path,'utf8')).trim().split('\n').map(JSON.parse);
 const events=records.filter(r=>['tool/call','tool/result','user/message','turn/end','agent/error'].includes(r.type));
 const calls=events.filter(r=>r.type==='tool/call'&&r.data.name==='subagent');
 for(const call of calls){const args=typeof call.data.arguments==='string'?JSON.parse(call.data.arguments):call.data.arguments;assert(!args.provider&&!args.model);}
 let output=null;try{output=JSON.parse((await readFile(row.output_path,'utf8')).replace(/^\uFEFF/,''));}catch(e){if(e.code!=='ENOENT')throw e;}
 let passed=false;
 if(results.length&&results.every(r=>r.status==='completed')){
  assert(calls.length===1);for(const r of results){assert.equal(r.actual_model,'gpt-5.6-luna');assert.equal(r.sandbox_policy,'dangerFullAccess');assert.equal(r.approval_policy,'never');assert(r.command_count>0);assert.equal(r.parent_life,row.life_id);assert.equal(r.parent_session,row.session_id);}
  assert(output);assert.equal(output.nonce,row.input.nonce);assert.equal(output.sum,row.input.a+row.input.b);assert.equal(output.life_id,row.life_id);assert.equal(resolve(output.cwd),resolve(life.deployment.workspace));passed=true;
 }
 const interrupted=[];
 for(const r of results.filter(r=>['queued','starting','running'].includes(r.status)))try{process.kill(r.worker_pid,0);}catch(e){if(e.code==='ESRCH')interrupted.push({child_id:r.child_id,worker_pid:r.worker_pid,reason:'owner process exited; persisted running status is historical'});else throw e;}
 await writeFile(resolve(report,label+'-evidence.json'),JSON.stringify({checked_at:new Date().toISOString(),passed,execution_disabled:deployments.workers[life.lifeId].execution_disabled===true,session_id:row.session_id,life_id:row.life_id,results,interrupted,output,events},null,2));
 console.log(JSON.stringify({passed,session_id:row.session_id,results:results.map(({output,...r})=>r),output}));
}else throw new Error('submit or inspect required');
