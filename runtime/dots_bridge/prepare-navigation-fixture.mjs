/** Isolated regression store: import one verified real anchor; never reset live quotas. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {registerProfile,approveProfile,withManager} from '../native_dsh/capabilities/profiles.mjs';
const source='.local/workspace/development/plugins/persona-dots';
const {createBridge,DEFAULT_ROOT}=await import(pathToFileURL(source+'/plugin.mjs'));
const root=resolve(import.meta.dirname,'../../reports/dots_bridge/thread-navigation-fixture'),data=resolve(root,'data'),profiles=resolve(root,'profiles');
await mkdir(data,{recursive:true});
await writeFile(resolve(data,'connection.json'),await readFile(resolve(DEFAULT_ROOT,'connection.json')),{flag:'wx'});
const deny={resolve:async()=>{throw Error('NO_CREDENTIAL_NEEDED_FOR_ANCHOR_IMPORT');}};
const live=await createBridge(deny),fixture=await createBridge(deny,data);
try{
  const anchor=live.get('dot-cff6f6ce-1808-5e4e-96a7-e0256a37d390');
  const messages=live.store.messages(anchor.id);
  if(anchor.status!=='completed'||!anchor.first_read_at||anchor.followups!==2||messages.map(m=>m.phase).join(',')!=='ACCEPTED,RESULT,DONE')throw Error('VERIFIED_REAL_ANCHOR_REQUIRED');
  fixture.store.put(anchor);
  for(const {seq,hash,...m} of messages)fixture.store.record(anchor,m);
  fixture.store.event(anchor,'real_anchor_imported_for_navigation_regression',{
    source:'original protected/tasks.sqlite3',source_task_hash:createHash('sha256').update(JSON.stringify(anchor)).digest('hex'),
    source_message_ids:messages.map(m=>m.source_id),source_message_hashes:messages.map(m=>m.hash),
    real_model_creation:'persona-native-slack/turn-1791185361827.json',real_model_read:'persona-native-slack/turn-1791185489678.json',
    boundary:'real immutable completed anchor, original followups retained at 2/3; original store and daily limit untouched; no simulated response'});
}finally{await live.close();await fixture.close();}
await registerProfile(profiles,{id:'dots',kind:'plugin',description:'isolated live thread navigation regression',credentialRefs:['DL_DOTS_SLACK_TOKEN']});
await withManager(profiles,'dots',async manager=>{
  const result=await manager.installBundle(source,{enabled:false});if(result.application==='failed')throw Error('NATIVE_INSTALL_FAILED');
  await manager.setBundleEnabled('persona-dots',true);
});
await writeFile(resolve(profiles,'dots/cordis.patch.yml'),`- id: persona-dots\n  config:\n    root: '${data.replaceAll('\\','/')}'\n`);
await approveProfile(profiles,'dots');
console.log(JSON.stringify({prepared:true,root,anchor_imported:true,original_store_modified:false,policy_modified:false,native_worker:true}));
