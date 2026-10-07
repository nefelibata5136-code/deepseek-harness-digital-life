// Read the real native events and independently verify the GUI-created file.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hostRequest, history } from '../desktop_persona/index.mjs';

const root = resolve(import.meta.dirname, '../../reports/windows_computer');
const task = JSON.parse(await readFile(resolve(root,'submitted-task.json'),'utf8'));
const fixture = JSON.parse(await readFile(resolve(root,'fixture-private.json'),'utf8'));
const response = JSON.parse(await readFile(resolve(root,'model-result.json'),'utf8'));
assert.equal(response.value.requestId,task.requestId,'Use the final run, not the cancelled result');
assert.equal(response.value.state,'completed');
assert(!task.text.includes(fixture.code),'Challenge code must not appear in the submitted prompt');
const path='.local/workspace/desktop-acceptance/persona-result.txt';
const bytes=await readFile(path);
const text=bytes.toString('utf8').replace(/^\uFEFF/,'').replace(/\r\n|\r/g,'\n').trim();
assert.equal(text,'人格已完成 Windows 视觉与操作验收\n'+fixture.code);
const log=await history(task.sessionId);
assert(!log.running);
const lastSeq=task.firstSeq+response.value.eventCount-1;
const rows=log.rows.filter(r=>r.seq>=task.firstSeq && r.seq<=lastSeq);
const calls=rows.filter(r=>r.role==='tool');
assert(calls.length>5);
const guiCalls=calls.filter(r=>r.text.startsWith('cua_driver_native__'));
const incidental=calls.filter(r=>!r.text.startsWith('cua_driver_native__'));
assert(incidental.every(r=>['read','edit'].includes(r.text) && r.args.file_path?.includes('/notes/')),
  'Non-GUI tools may only record the finished experience in Persona notes');
assert(!calls.some(r=>['read','read_image','terminal','write','edit'].includes(r.text)
  && /desktop-acceptance[\\/]/.test(r.args.file_path ?? r.args.command ?? '')),'Acceptance files must be operated through GUI');
for(const suffix of ['get_desktop_state','get_window_state','click','type_text','press_key','bring_to_front'])
  assert(calls.some(r=>r.text.endsWith('__'+suffix)&&r.status==='completed'),suffix);
const pictures=calls.flatMap(r=>(r.images??[]).map(ref=>({seq:r.seq,tool:r.text,ref})));
assert(pictures.length>=4);
const final=pictures.at(-1);
const image=await hostRequest('GET','/screenshot?'+new URLSearchParams({sessionId:task.sessionId,attachmentId:final.ref.attachmentId}));
assert.equal(image.status,200);
assert.equal('sha256:'+createHash('sha256').update(image.value).digest('hex'),final.ref.attachmentId);
await writeFile(resolve(root,'final-confirmation.png'),image.value);
const wrong=await hostRequest('GET','/screenshot?'+new URLSearchParams({sessionId:'665af1d3-9207-5ee1-9dbb-193a3e75e03d',attachmentId:final.ref.attachmentId}));
assert.equal(wrong.status,404);
const status=(await hostRequest('GET','/status')).value;
const receipt={passed:true,observedAt:new Date().toISOString(),sessionId:task.sessionId,requestId:task.requestId,
  firstSeq:task.firstSeq,lastSeq,computer:status.computer,actualNativeLoop:true,
  delegatedTask:task.text,codeWithheldFromPrompt:true,codeObserved:fixture.code,resultPath:path,resultText:text,
  resultBytes:bytes.length,resultSha256:createHash('sha256').update(bytes).digest('hex'),
  guiOnlyForTask:true,toolCalls:guiCalls.length,incidentalNoteTools:incidental.map(r=>r.text),failedAttempts:calls.filter(r=>r.status==='error').length,
  screenshots:pictures.length,finalScreenshot:final,unknownSessionScreenshotRefused:true,
  modelReply:response.value.text,errors:response.value.errors,budget:status.budget,
  limitations:['Primary display only in released Cua Driver target interface','Shared interactive Windows desktop; unlocked user session required',
    'UAC secure desktop and higher-integrity applications are not automatically elevated',
    'Driver foreground hotkey may reject XAML accelerators; press_key with modifiers is verified',
    'Cancelled API requests without final usage retain their full cost upper bound; control-side accounting never invents usage']};
await writeFile(resolve(root,'acceptance.json'),JSON.stringify(receipt,null,2));
await writeFile(resolve(root,'gui-timeline.json'),JSON.stringify({sessionId:task.sessionId,rows},null,2));
console.log(JSON.stringify({passed:true,code:fixture.code,resultPath:path,toolCalls:receipt.toolCalls,screenshots:receipt.screenshots,guiOnly:true}));
