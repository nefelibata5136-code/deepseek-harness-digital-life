// Read-only deployment state. Never stops, retries, wakes or reloads anything.
import {hostRequest} from '../desktop_persona/transport.mjs';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sources=['activity_progress/events.mjs','activity_progress/host.mjs','activity_progress/phases.mjs','activity_progress/policy.json','desktop_persona/client.js','desktop_persona/transport.mjs','native_dsh/foundation-host.mjs','native_dsh/host-components.mjs','native_dsh/native-host.mjs','workspace_foundation/file-operation-locks.mjs','workspace_foundation/lifecycle.mjs'];
const sourceSha256=Object.fromEntries(await Promise.all(sources.map(async p=>[p,createHash('sha256').update(await readFile(new URL('../'+p,import.meta.url))).digest('hex')])));
const live=(await hostRequest('GET','/status')).value;
let desktopLock=null;try{desktopLock=JSON.parse(await readFile(new URL('../agent_presence/.cache/locks/persona-desktop-test.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const result={observedAt:new Date().toISOString(),sourceSha256,host:{ready:live.ready,pid:live.pid,activeSessionIds:live.activeSessionIds,activityProgressVersion:live.activityProgress?.version??null},desktopLock:desktopLock?{id:desktopLock.id,task:desktopLock.task}:null,hostReloadSafe:live.ready&&live.activeSessionIds?.length===0,desktopReloadAvailable:!desktopLock,readOnly:true,modelCalls:0};
await writeFile(new URL('../../reports/activity_progress/release-preview.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
