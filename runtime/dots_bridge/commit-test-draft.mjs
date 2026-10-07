/** One-off recovery of this public test's draft. No typing, API post, or resend. */
import {pathToFileURL} from 'node:url';
import {credentialOperation} from '../native_dsh/capabilities/isolation.mjs';
const source='.local/workspace/development/plugins/persona-dots/';
const {createBridge}=await import(pathToFileURL(source+'plugin.mjs'));
const {SlackUiSender}=await import(pathToFileURL(source+'slack-ui.mjs'));
const bridge=await createBridge({resolve:ref=>credentialOperation('python','resolve',ref)});
const id='dot-472c5fce-d5f7-53e9-a33b-c0448eafbe87';
let ui;
try{
  const task=bridge.get(id);
  if(process.argv[2]!==id)throw Error('EXACT_TEST_DRAFT_REQUIRED');
  if(task.receipt){console.log(JSON.stringify({...bridge.summary(task),duplicate:true}));}
  else{
    if(task.status!=='unknown'||task.error!=='SLACK_UI_SEND_CONTROL_AMBIGUOUS'||task.correlation_id!=='dot-cff6f6ce-1808-5e4e-96a7-e0256a37d390'||task.thread!=='1791185352.317389')throw Error('PRECLICK_TEST_DRAFT_REQUIRED');
    const history=bridge.history(id).events;
    const attempt=history.findLast(e=>e.kind==='verified_draft_commit_started');
    if(attempt&&!history.some(e=>e.kind==='maintainer_verified_nonmutating_refusal'&&e.seq>attempt.seq&&e.value?.code==='SLACK_UI_WINDOW_MINIMIZED'))throw Error('COMMIT_ALREADY_ATTEMPTED_DO_NOT_REPLAY');
    const signal=AbortSignal.timeout(26000),tr=bridge.transport;
    const health=await tr.health(signal);if(!health.ready)throw Error('READ_PREFLIGHT_FAILED');
    const before=await tr.poll({receipt:{channel_id:tr.connection.channel_id},thread:task.thread},null,signal);
    if((before.messages??[]).some(m=>m.text?.includes(`[DL_DOTS_REQUEST ${id}]`)))throw Error('TASK_MESSAGE_ALREADY_EXISTS_DO_NOT_CLICK');
    ui=new SlackUiSender(tr.connection);
    bridge.store.event(task,'verified_draft_commit_started',{actor:'persona',native_call_id:process.argv[3],boundary:'finish exact full existing draft after proven pre-click control ambiguity; no new message body or quota override'});
    await ui.commitVerifiedDraft(task,task.wire_text,signal);
    const receipt=await tr.uiReceipt(task,{user_id:tr.connection.sender_user_id},signal);
    task.receipt=receipt;task.status='submitted';task.submitted_at=bridge.now();task.error=null;
    bridge.store.put(task);bridge.store.event(task,'submitted',{receipt,recovered_from:'SLACK_UI_SEND_CONTROL_AMBIGUOUS'});
    console.log(JSON.stringify(bridge.summary(task)));
  }
}catch(e){console.log(JSON.stringify({status:'unknown',code:/^[A-Z0-9_]+$/.test(e.message)?e.message:'COMMIT_OUTCOME_UNCONFIRMED_DO_NOT_REPLAY'}));}
finally{await ui?.close();await bridge.close();}
