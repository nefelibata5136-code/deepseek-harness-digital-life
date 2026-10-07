/** Resume one proven pre-click test failure. Never replay an uncertain send. */
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
const source='.local/workspace/development/plugins/persona-dots/';
const {createBridge}=await import(pathToFileURL(source+'plugin.mjs'));
const root=resolve(import.meta.dirname,'../../reports/dots_bridge/thread-navigation-fixture/data');
const bridge=await createBridge({resolve:ref=>credentialOperation('python','resolve',ref)},root);
const id='dot-fb2bcf36-b6ec-5ed1-9946-341e7c2e1094';
try{
  const task=bridge.get(id);
  if(process.argv[2]!==id||!process.argv[3])throw Error('EXACT_NATIVE_RECOVERY_CALL_REQUIRED');
  if(task.receipt){console.log(JSON.stringify({...bridge.summary(task),duplicate:true}));}
  else{
    if(task.status!=='unknown'||task.error!=='SLACK_UI_DRAFT_READBACK_MISMATCH'||task.thread!=='1791185352.317389'||task.correlation_id!=='dot-cff6f6ce-1808-5e4e-96a7-e0256a37d390')throw Error('PROVEN_PRECLICK_TEST_FAILURE_REQUIRED');
    const history=bridge.history(id).events;
    if(history.some(e=>e.kind==='preclick_focus_recovery_started'))throw Error('RECOVERY_ALREADY_ATTEMPTED_DO_NOT_REPLAY');
    if(history.some(e=>e.kind==='preclick_recovery_started')){
      const path=resolve(import.meta.dirname,'../../reports/dots_bridge/persona-native-thread/turn-1791188622415.json');
      const bytes=await readFile(path);const report=JSON.parse(bytes);
      const call=report.calls.find(c=>c.name==='recover_proven_preclick_test');
      const result=report.results.find(r=>r.message.toolCallId===call?.callId);
      const value=JSON.parse(result?.message.content?.[0]?.text??'null');
      if(report.sessionId!=='06646b2d-4afb-51d6-aa95-4732fcaaf784'||value?.code!=='SLACK_UI_DOT_MENTION_AMBIGUOUS'||JSON.parse(call.arguments).task_id!==id)throw Error('NONMUTATING_RECOVERY_REFUSAL_PROOF_REQUIRED');
      bridge.store.event(task,'preclick_recovery_verified_nonmutating_refusal',{source:path,sha256:createHash('sha256').update(bytes).digest('hex'),native_call_id:call.callId,code:value.code,boundary:'Dot mention lookup fails before body paste or send click; exact UIA focus readback repaired'});
    }
    const signal=AbortSignal.timeout(26000),tr=bridge.transport;
    if(!(await tr.health(signal)).ready)throw Error('RECOVERY_READ_PREFLIGHT_FAILED');
    // Both channel and exact thread must show no prior request. Refuse partial
    // pages: a marker on a later page would otherwise permit a duplicate.
    for(const input of [{channel:tr.connection.channel_id,limit:100},{channel:tr.connection.channel_id,ts:task.thread,limit:100}]){
      const response=await tr.api(input.ts?'conversations.replies':'conversations.history',input,signal);
      if(response.has_more||response.response_metadata?.next_cursor)throw Error('RECOVERY_FULL_HISTORY_REQUIRED');
      if((response.messages??[]).some(m=>m.text?.includes(`[DL_DOTS_REQUEST ${id}]`)))throw Error('REQUEST_ALREADY_EXISTS_DO_NOT_SEND');
    }
    bridge.store.event(task,'preclick_focus_recovery_started',{actor:'persona',native_call_id:process.argv[3],
      evidence:'old source throws DRAFT_READBACK_MISMATCH before send click; channel and exact thread contain no request; original task, text, counters and history preserved'});
    const receipt=await tr.send(task,task.wire_text,signal);
    task.receipt=receipt;task.status='submitted';task.submitted_at=bridge.now();task.error=null;
    bridge.store.put(task);bridge.store.event(task,'submitted',{receipt,recovered_from:'SLACK_UI_DRAFT_READBACK_MISMATCH'});
    console.log(JSON.stringify(bridge.summary(task)));
  }
}catch(e){console.log(JSON.stringify({status:'unknown',code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'RECOVERY_OUTCOME_UNKNOWN_DO_NOT_REPLAY'}));}
finally{await bridge.close();}
