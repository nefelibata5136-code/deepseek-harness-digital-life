// Host-only, read-only acceptance evidence. No Host token, credential resolver,
// prompt sender, Agent, or model transport is imported by this module.
import {open,readFile,readdir,realpath,stat,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {sessionFormatCatalog} from '@deepseek-ai/dsh-session-format-catalog';

const runFile=promisify(execFile);
const defaultWorld=resolve(import.meta.dirname,'../../../multi_life_supervisor');
const usageScript=resolve(import.meta.dirname,'../budget/usage.py');
const pythonDefault=(process.env.DL_PYTHON || 'python');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ident=/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,255}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
function fail(code){const error=new Error(code);error.code=code;throw error;}
function sessionIdentity(value){if(typeof value!=='string'||!uuid.test(value))fail('EXACT_UUID_SESSION_REQUIRED');return value;}
function safeId(value){return typeof value==='string'&&ident.test(value)&&!value.toLowerCase().startsWith('sk-')?value:null;}
function integer(value){return Number.isSafeInteger(value)&&value>=0?value:null;}
function inside(root,path){const r=relative(root,path);return r===''||(!r.startsWith('..')&&!isAbsolute(r));}
function cleanText(text){
  return String(text??'')
    .replace(/<(think|reasoning)\b[^>]*>[\s\S]*?<\/\1>/gi,'[reasoning omitted]')
    .replace(/<(think|reasoning)\b[^>]*>[\s\S]*$/gi,'[reasoning omitted]')
    .replace(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|authorization|cookie|secret)\s*["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'$1[credential omitted]')
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g,'[credential omitted]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi,'Bearer [credential omitted]');
}
function visibleText(message){return (Array.isArray(message?.content)?message.content:[]).filter(b=>b?.type==='text'&&typeof b.text==='string').map(b=>cleanText(b.text)).join('\n');}
function bodyBytes(value){return Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value??null));}
function sourceMetadata(source){return {kind:safeId(source?.kind),request_id:safeId(source?.rpcId),room_id:safeId(source?.roomId??source?.conversationId),
  reason_kind:safeId(source?.reasonKind),sender_types:(source?.sender_types??[source?.sender?.sender_type]).filter(v=>['human','life'].includes(v))};}
function usageMetadata(value){
  const result={};for(const name of ['inputTokens','outputTokens','cacheHitTokens','cacheMissTokens','reasoningTokens','input_tokens','output_tokens','prompt_tokens','completion_tokens','cache_read_input_tokens','cache_creation_input_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','reasoning_tokens']){
    const number=integer(value?.[name]);if(number!==null)result[name]=number;
  }return result;
}
function streamMetadata(stream){
  const out=[];for(const record of Array.isArray(stream)?stream:[]){
    // The compact stream also contains private reasoning and tool argument
    // deltas. Never expand it or serialize arbitrary record/chunk fields.
    const c=record?.type==='chunk'?record.chunk:record;
    if(c?.type==='usage')out.push({type:'usage',usage:usageMetadata(c.usage??c)});
    if(c?.type==='finish')out.push({type:'finish',kind:safeId(c.kind),error_code:safeId(c.failure?.code)});
  }return out;
}
async function headerOnly(path){
  // One-byte reads stop at the physical header newline. No body bytes of a
  // different Session are read, including a tiny one-line journal.
  const fd=await open(path,'r');const bytes=[];const buffer=Buffer.alloc(1);
  try{for(let offset=0;offset<65536;offset++){
    const {bytesRead}=await fd.read(buffer,0,1,offset);if(!bytesRead)break;
    if(buffer[0]===10)break;bytes.push(buffer[0]);if(offset===65535)fail('SESSION_HEADER_TOO_LARGE');
  }}finally{await fd.close();}
  let h;try{h=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{fail('SESSION_HEADER_INVALID');}
  if(h?.type!=='session'||h.version!==4||typeof h.id!=='string'||typeof h.isSeeded!=='boolean'||integer(h.createdAt)===null||integer(h.delegationDepth)===null)fail('CURRENT_NATIVE_HEADER_REQUIRED');
  return h;
}

/** Exact native path lookup: root/<project>/<UUID>/session.v4.jsonl only. */
export async function findSessionPath(root,sessionId){
  sessionIdentity(sessionId);const base=await realpath(root);const candidates=[];
  // Also accept a named project directory as root. No recursive corpus scan.
  const projects=[base];for(const entry of await readdir(base,{withFileTypes:true}))if(entry.isDirectory()&&!entry.isSymbolicLink())projects.push(join(base,entry.name));
  for(const project of projects){const candidate=join(project,sessionId,'session.v4.jsonl');let path;
    try{path=await realpath(candidate);}catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))continue;throw e;}
    if(!inside(base,path))fail('SESSION_PATH_ESCAPES_ROOT');
    const h=await headerOnly(path);if(h.id!==sessionId)fail('SESSION_HEADER_ID_MISMATCH');candidates.push(path);
  }
  const paths=[...new Set(candidates)];if(paths.length!==1)fail(paths.length?'DUPLICATE_NATIVE_SESSION':'NATIVE_SESSION_NOT_FOUND');return paths[0];
}

async function testBinding(sessionId,options){
  const registryPath=options.worldRegistryPath??join(defaultWorld,'registry/registry.json');
  let world;try{world=JSON.parse(await readFile(registryPath,'utf8'));}catch{fail('HOST_WORLD_METADATA_REQUIRED');}
  if(!world?.lives||typeof world.lives!=='object')fail('HOST_WORLD_METADATA_INVALID');
  const lives=Object.values(world.lives);
  if(lives.some(l=>l.authoritySessionId===sessionId)||(options.authoritySessionIds??[]).includes(sessionId))fail('MAIN_SESSION_EVIDENCE_FORBIDDEN');
  const paths=options.testStorePaths??lives.map(l=>join(dirname(dirname(registryPath)),'workers',l.lifeId,'test-sessions.json'));
  const matches=[];for(const path of paths){let store;
    try{store=JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')continue;fail('HOST_TEST_METADATA_INVALID');}
    if(store?.schema_version!==1||!Array.isArray(store.sessions)||!lives.some(l=>l.lifeId===store.life_id))fail('HOST_TEST_METADATA_INVALID');
    for(const row of store.sessions)if(row.session_id===sessionId){
      if(row.source!=='host-developer-ultra-test')fail('EXPLICIT_HOST_TEST_SESSION_REQUIRED');
      matches.push({life_id:store.life_id,session_id:sessionId,title:cleanText(row.title),source:row.source,created_at:row.created_at});
    }
  }
  if(matches.length!==1)fail(matches.length?'DUPLICATE_HOST_TEST_SESSION':'EXPLICIT_HOST_TEST_SESSION_REQUIRED');return matches[0];
}

function formatFailure(error,phase,rowIndex){
  // Codec diagnostics can contain arbitrary extension names or tool identities.
  // Export only a fixed technical vocabulary, never an arbitrary error message.
  const messages=new Map([
    ['title messageSeqs requires an array','TITLE_MESSAGE_SEQS_MISSING'],
    ['title source requires an object','TITLE_SOURCE_MISSING'],
    ['replacement sourceEventSeqs omit a shadowed surface node','REPLACEMENT_SOURCE_COVERAGE_INVALID'],
    ['surface replacement cannot shadow the protected system head','PROTECTED_SYSTEM_HEAD_REPLACEMENT_INVALID']
  ]);
  const message=String(error?.message??'');
  const failure=new Error('NATIVE_SESSION_FORMAT_INVALID');failure.code='NATIVE_SESSION_FORMAT_INVALID';
  failure.format_error={codec:'official-installed-session-format-catalog',validation:'current',recovery:'strict',phase,physical_row:rowIndex,
    error_type:safeId(error?.name),technical_code:messages.get(message)??'OFFICIAL_FORMAT_VALIDATION_FAILED',
    technical_message:messages.has(message)?message:null,error_message_omitted:!messages.has(message)};
  return failure;
}

function decodeNativeJournal(text,header){
  const complete=text.endsWith('\n'),lines=text.split('\n');
  let observedHeader;try{observedHeader=JSON.parse(lines.shift());}catch{fail('SESSION_HEADER_INVALID');}
  if(JSON.stringify(observedHeader)!==JSON.stringify(header))fail('NATIVE_HEADER_CHANGED_DURING_READ');
  // Keep a torn, non-newline-terminated tail explicit. Every committed physical
  // row is passed to the official strict codec, including seq 0 and replacements.
  lines.pop();let restore;
  try{restore=sessionFormatCatalog.createRestore(observedHeader,{validation:'current',recovery:'strict'});}catch(error){throw formatFailure(error,'header',null);}
  for(const [index,line] of lines.entries()){
    let row;try{row=JSON.parse(line);}catch{fail('NATIVE_EVENT_JSON_INVALID');}
    try{restore.decodeRow(row);}catch(error){throw formatFailure(error,'decode-row',index);}
  }
  let artifact;try{artifact=restore.finish();}catch(error){throw formatFailure(error,'finish',null);}
  return {artifact,complete,physicalRows:lines.length};
}

/** Safe evidence from a Host-registered, unseeded independent test Session. */
export async function collectEvidence(root,sessionId,{afterSeq=0,maxBytes=64*1024*1024,expectedMarkers=[],...options}={}){
  sessionIdentity(sessionId);if((afterSeq!==-1&&integer(afterSeq)===null)||integer(maxBytes)===null)fail('INVALID_EVIDENCE_WINDOW');
  const binding=await testBinding(sessionId,options);const path=await findSessionPath(root,sessionId);const h=await headerOnly(path);
  if(h.isSeeded||h.parentSession||h.origin==='subagent'||(h.delegationDepth??0)>0)fail('FRESH_INDEPENDENT_TEST_SESSION_REQUIRED');
  const metadata=await stat(path);if(metadata.size>maxBytes)fail('EVIDENCE_JOURNAL_LIMIT_EXCEEDED');
  // Read only the bytes present at this observation. A writer's unfinished last
  // record is reported explicitly and is never repaired or silently accepted.
  const fd=await open(path,'r');const buffer=Buffer.alloc(metadata.size);let read=0;
  try{while(read<buffer.length){const r=await fd.read(buffer,read,buffer.length-read,read);if(!r.bytesRead)break;read+=r.bytesRead;}}finally{await fd.close();}
  if(read!==buffer.length)fail('NATIVE_JOURNAL_CHANGED_DURING_READ');
  const {artifact,complete,physicalRows}=decodeNativeJournal(buffer.toString('utf8'),h);
  const all=artifact.events,lastSeq=all.at(-1)?.seq??null;
  const sensitiveTurns=new Set(),calls=new Map();
  for(const event of all)if(event.type==='tool/call'){
    const d=event.data??{};calls.set(d.callId,d);
    if(/private|credential|secret|vault|memory|recall|session.*(?:query|history)/i.test(String(d.name))||/(?:\.credentials|secret-input|private[_-]root|[\\/]Memory[\\/])/i.test(String(d.arguments)))sensitiveTurns.add(d.turn);
  }
  const evidence=[];let currentTurn=null,currentRequest=null;const markers=expectedMarkers.map(value=>{if(typeof value!=='string'||!value||value.length>1024)fail('INVALID_EXPECTED_MARKER');return value;});
  for(const event of all){const d=event.data??{};if(event.type==='turn/start')currentTurn=d.turn;
    if(event.type==='user/message'&&d.source?.rpcId)currentRequest=safeId(d.source.rpcId);
    if(event.seq<=afterSeq)continue;
    const common={seq:event.seq,time:integer(event.time),type:event.type,turn:integer(d.turn??currentTurn),step:integer(d.step),request_id:currentRequest,
      ...(event.surfaceOp===undefined?{}:{surface_op:event.surfaceOp}),...(event.sourceEventSeqs===undefined?{}:{source_event_seqs:event.sourceEventSeqs})};
    if(event.type==='user/message')evidence.push({...common,source:sourceMetadata(d.source),body_omitted:true});
    else if(event.type==='agent/inbox/spliced')evidence.push({...common,inserted:(d.inserted??[]).map(m=>({role:safeId(m.role),source:sourceMetadata(m.source),body_omitted:true}))});
    else if(event.type==='turn/start')evidence.push(common);
    else if(event.type==='turn/end')evidence.push({...common,reason:safeId(d.reason?.kind??d.reason),error_code:safeId(d.reason?.error?.code),error_message_omitted:!!d.reason?.error});
    else if(event.type==='request/header'){
      const c=d.header?.config??{};evidence.push({...common,provider:safeId(c.provider),model:safeId(c.model),reasoning_effort:['high','medium','low','off'].includes(c.reasoningEffort)?c.reasoningEffort:null,
        max_tokens:integer(c.maxTokens),header_reason:safeId(d.reason),tool_names:(d.header?.tools??[]).map(t=>safeId(t.name)).filter(Boolean),prompt_omitted:true});
    }else if(event.type==='request/context')evidence.push({...common,provider:safeId(d.provider),model:safeId(d.model),context_window:integer(d.contextWindow),prompt_omitted:true});
    else if(event.type==='tool/call')evidence.push({...common,name:safeId(d.name),call_id:safeId(d.callId),arguments_bytes:bodyBytes(d.arguments),arguments_omitted:true,private_content_omitted:sensitiveTurns.has(d.turn)});
    else if(event.type==='tool/result'){
      const id=d.message?.source?.callId??d.message?.toolCallId;const privateContent=sensitiveTurns.has(d.turn);const raw=visibleText(d.message);
      evidence.push({...common,name:safeId(calls.get(id)?.name),call_id:safeId(id),is_error:!!d.message?.isError,result_bytes:bodyBytes(d.message?.content),result_omitted:true,
        error_code:safeId(d.error?.code),private_content_omitted:privateContent,expected_markers:privateContent?[]:markers.map(marker=>({marker:cleanText(marker),present:raw.includes(marker)}))});
    }else if(event.type==='assistant/message'||event.type==='assistant/attempt'){
      const privateContent=sensitiveTurns.has(d.turn);const visible=privateContent?'':visibleText(d.message);
      evidence.push({...common,provider:safeId(d.message?.source?.provider),model:safeId(d.message?.source?.model),interrupted:!!d.interrupted,
        usage:usageMetadata(d.usage),finish:streamMetadata(d.stream),text:visible||null,text_sha256:visible?hash(visible):null,
        reasoning_omitted:true,private_content_omitted:privateContent,is_final_visible_message:event.type==='assistant/message'&&event.surfaceOp==='append'&&!(d.message?.content??[]).some(b=>b.type==='tool-call')});
    }else if(/(?:error|failed)$/.test(event.type))evidence.push({...common,error_code:safeId(d.code??d.error?.code),error_message_omitted:true});
  }
  const final=evidence.findLast(e=>e.is_final_visible_message&&e.text);
  return {schema_version:1,observed_at:new Date().toISOString(),binding,native_path:path,header:{id:h.id,version:h.version,created_at:h.createdAt,is_seeded:h.isSeeded,delegation_depth:h.delegationDepth},
    after_seq:afterSeq,observed_bytes:metadata.size,last_complete_seq:lastSeq,complete,unfinished_tail_omitted:!complete,
    format_validation:{codec:'official-installed-session-format-catalog',validation:'current',recovery:'strict',valid:true,physical_rows:physicalRows,decoded_events:all.length},
    events:evidence,final_assistant_text:final?.text??null,
    paid_calls_triggered:0,credential_reads:0,reasoning_exported:false,tool_bodies_exported:false,source:'exact-native-independent-test-journal'};
}

/** Reuse the read-only cost CLI; no DB repair or full-history scan. */
export async function readUsage({sessionId,requestIds=[],roots=[],ledgers=[],day,after,before,python=pythonDefault}={}){
  sessionIdentity(sessionId);if(!roots.length&&!ledgers.length)fail('EXPLICIT_USAGE_LEDGER_REQUIRED');
  const args=[usageScript,'--session-id',sessionId];for(const path of roots)args.push('--root',resolve(path));for(const path of ledgers)args.push('--ledger',resolve(path));
  for(const id of requestIds){if(!safeId(id))fail('EXACT_REQUEST_ID_REQUIRED');args.push('--request-id',id);}
  if(day)args.push('--day',day);if(after)args.push('--after',after);if(before)args.push('--before',before);
  let output;try{output=await runFile(python,['-B','-X','utf8',...args],{windowsHide:true,timeout:30000,maxBuffer:16*1024*1024});}catch{fail('READ_ONLY_USAGE_QUERY_FAILED');}
  try{return JSON.parse(output.stdout);}catch{fail('USAGE_RESPONSE_INVALID');}
}

/** Matched repeated-session observation, not a cache optimization claim. */
export function assessCachePair(usage,{lifeId,sessionId,requestIds=[]}={}){
  sessionIdentity(sessionId);const rows=(usage.requests??[]).filter(r=>r.session_id===sessionId&&(!lifeId||r.life_id===lifeId)&&(!requestIds.length||requestIds.includes(r.request_id)));
  const groups=new Map();for(const row of rows){const group=groups.get(row.request_id)??[];group.push(row);groups.set(row.request_id,group);}
  const requests=[...groups].map(([request_id,attempts])=>({request_id,attempts}));
  const settled=rows.every(r=>r.state==='settled'&&r.known_usage===true&&Number.isSafeInteger(r.input_tokens)&&Number.isSafeInteger(r.prompt_cache_hit_tokens)&&Number.isSafeInteger(r.prompt_cache_miss_tokens));
  const signatures=rows.map(r=>JSON.stringify([r.model,r.prompt_metadata?.system_hash,r.prompt_metadata?.tools_hash,r.prompt_metadata?.first_message_hash,r.prompt_metadata?.reasoning_effort,r.prompt_metadata?.thinking_mode]));
  const fingerprintCoverage=rows.every(r=>['system_hash','tools_hash','first_message_hash'].every(k=>/^[a-f0-9]{64}$/.test(r.prompt_metadata?.[k]??'')));
  return {life_id:lifeId??null,session_id:sessionId,matched_requests:requests.length,provider_attempts:rows.length,
    exactly_one_attempt_per_request:requests.length>=2&&requests.every(r=>r.attempts.length===1),all_settled_with_cache_usage:rows.length>=2&&settled,
    actual_wire_high:rows.length>=2&&rows.every(r=>r.prompt_metadata?.reasoning_effort==='high'&&r.prompt_metadata?.thinking_mode==='enabled'),
    developer_test_attribution:rows.length>=2&&rows.every(r=>r.reason==='developer_test'),fingerprint_coverage_complete:rows.length>=2&&fingerprintCoverage,
    stable_observed_prefix:rows.length>=2&&fingerprintCoverage&&new Set(signatures).size===1,
    sequence:requests.map((r,index)=>({position:index?'repeated_in_selected_session_window':'first_in_selected_session_window',request_id:r.request_id,
      attempts:r.attempts.map(a=>({attempt_id:a.attempt_id,provider_request_id:a.provider_request_id,input_tokens:a.input_tokens,prompt_cache_hit_tokens:a.prompt_cache_hit_tokens,prompt_cache_miss_tokens:a.prompt_cache_miss_tokens,
        cache_hit_rate:a.input_tokens?a.prompt_cache_hit_tokens/a.input_tokens:null,output_tokens:a.output_tokens,reasoning_tokens:a.reasoning_tokens,local_estimated_cost_nano_cny:a.local_estimated_cost_nano_cny}))})),
    cache_improvement_claimed:false,first_call_proves_cold_cache:false,credential_billing_account_verified:false};
}

async function selfTest(){
  const assert=(await import('node:assert/strict')).default;const base=await mkdtemp(join(tmpdir(),'persona-host-evidence-中文-'));
  const {Session,SessionId}=await import('@deepseek-ai/dsh-session');
  const {createUserMessage,createAssistantMessage,createSystemMessage,createToolResultMessage}=await import('@deepseek-ai/dsh-llm');
  try{const life='life-'+randomUUID(),authority=randomUUID(),id=randomUUID();const root=join(base,'sessions'),dir=join(root,'project',id);await mkdir(dir,{recursive:true});
    const registry=join(base,'world/registry/registry.json'),store=join(base,'world/workers',life,'test-sessions.json');await mkdir(dirname(registry),{recursive:true});await mkdir(dirname(store),{recursive:true});
    await writeFile(registry,JSON.stringify({lives:{[life]:{lifeId:life,authoritySessionId:authority}}}));
    await writeFile(store,JSON.stringify({schema_version:1,life_id:life,sessions:[{session_id:id,title:'safe synthetic evidence',source:'host-developer-ultra-test'}]}));
    // Generate complete native events and messages through installed first-party
    // APIs, then encode their physical rows with the official current encoder.
    const fixture=(toolName='fixture')=>{
      const s=Session.create(SessionId(id),undefined,{version:4,id,createdAt:1,isSeeded:false,delegationDepth:0}),events=[];
      const append=(type,data,metadata)=>{const e=s.append(type,data,...(metadata?[metadata]:[]));events.push(e);return e;};
      append('session/title',{title:'safe synthetic evidence',messageSeqs:[],source:{kind:'user'}});
      append('turn/start',{turn:1});append('step/start',{turn:1,step:1});
      append('system/message',{turn:1,step:1,message:createSystemMessage('SYSTEM PROMPT MUST NOT EXPORT')},{surfaceOp:'append'});
      append('user/message',createUserMessage({source:{kind:'developer-test',rpcId:'acceptance-rpc-1'},content:[{type:'text',text:'USER BODY MUST NOT EXPORT'}]}),{surfaceOp:'append'});
      const snapshot=append('user/message',createUserMessage({source:{kind:'host-notice',form:'snapshot'},content:[{type:'text',text:'OLD SNAPSHOT MUST NOT EXPORT'}]}),{surfaceOp:'append'});
      append('user/message',createUserMessage({source:{kind:'host-notice',form:'snapshot'},content:[{type:'text',text:'NEW SNAPSHOT MUST NOT EXPORT'}]}),
        {surfaceOp:{op:'replace',startSeq:snapshot.seq,endSeq:snapshot.seq},sourceEventSeqs:[snapshot.seq]});
      append('request/header',{reason:'initial',header:{config:{provider:'deepseek',model:'deepseek-v4-flash',reasoningEffort:'high'},
        tools:[{name:toolName,description:'PROMPT MUST NOT EXPORT',parameters:{type:'object',properties:{}}}]}});
      const args='{"api_key":"sk-synthetic123456789"}',callId='call-1',source={provider:'deepseek',model:'deepseek-v4-flash'};
      append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source,content:[{type:'tool-call',id:callId,name:toolName,arguments:args}]}),stream:[]},{surfaceOp:'append'});
      const call=append('tool/call',{turn:1,step:1,name:toolName,callId,arguments:args});
      const result=append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId,isError:false,content:[{type:'text',text:'ACCEPTANCE_MARKER'}]})},
        {surfaceOp:'append',sourceEventSeqs:[call.seq]});
      append('tool/result',{...result.data,message:{...result.data.message,content:[{type:'text',text:'ACCEPTANCE_MARKER REWRITTEN'}]}},
        {surfaceOp:{op:'replace',startSeq:result.seq,endSeq:result.seq},sourceEventSeqs:[result.seq]});
      append('step/end',{turn:1,step:1});append('step/start',{turn:1,step:2});
      append('assistant/message',{turn:1,step:2,message:createAssistantMessage({source,content:[{type:'reasoning',text:'REASONING MUST NOT EXPORT'},{type:'text',text:'done api_key=sk-synthetic123456789'}]}),
        stream:[{type:'reasoning-chunks',time0:1,index:0,dt:[0],texts:['STREAM MUST NOT EXPORT']},{type:'chunk',time:2,chunk:{type:'finish',kind:'completed'}}]},
        {surfaceOp:'append'});
      append('step/end',{turn:1,step:2});append('turn/end',{turn:1,reason:{kind:'completed'}});
      return {header:sessionFormatCatalog.encodeCurrentHeader(s.header,0),events:events.map(e=>sessionFormatCatalog.encodeCurrentEvent(e))};
    };
    const {header,events}=fixture(),path=join(dir,'session.v4.jsonl');const encodedFixture=()=>[header,...events].map(v=>JSON.stringify(v)).join('\n')+'\n';
    await writeFile(path,encodedFixture());
    assert.equal(await findSessionPath(root,id),path);const options={worldRegistryPath:registry,expectedMarkers:['ACCEPTANCE_MARKER']};const result=await collectEvidence(root,id,options),encoded=JSON.stringify(result);
    assert.equal(result.events.find(e=>e.type==='request/header').reasoning_effort,'high');assert.equal(result.events.find(e=>e.type==='tool/result').expected_markers[0].present,true);
    assert.equal(result.format_validation.valid,true);assert.equal(result.format_validation.decoded_events,events.length);assert.equal(events[0].seq,0);
    assert.equal((await collectEvidence(root,id,{...options,afterSeq:-1})).format_validation.valid,true);
    assert.equal(result.events.filter(e=>e.surface_op?.op==='replace').length,2);
    assert.deepEqual(result.events.find(e=>e.type==='tool/result'&&e.surface_op?.op==='replace').source_event_seqs,[10]);
    for(const forbidden of ['USER BODY MUST NOT EXPORT','PROMPT MUST NOT EXPORT','OLD SNAPSHOT MUST NOT EXPORT','NEW SNAPSHOT MUST NOT EXPORT','REASONING MUST NOT EXPORT','STREAM MUST NOT EXPORT','sk-synthetic123456789'])assert(!encoded.includes(forbidden));
    assert.equal(result.final_assistant_text,'done api_key=[credential omitted]');
    assert.equal((await collectEvidence(root,id,{...options,afterSeq:events.at(-1).seq-1})).events.length,1);
    await assert.rejects(collectEvidence(root,authority,options),{code:'MAIN_SESSION_EVIDENCE_FORBIDDEN'});
    await assert.rejects(collectEvidence(root,randomUUID(),options),{code:'EXPLICIT_HOST_TEST_SESSION_REQUIRED'});
    await writeFile(path,JSON.stringify({...header,id:randomUUID()})+'\n');await assert.rejects(findSessionPath(root,id),{code:'SESSION_HEADER_ID_MISMATCH'});
    await writeFile(path,JSON.stringify({...header,isSeeded:true})+'\n');await assert.rejects(collectEvidence(root,id,options),{code:'FRESH_INDEPENDENT_TEST_SESSION_REQUIRED'});
    await writeFile(path,encodedFixture()+'{"unfinished":');assert.equal((await collectEvidence(root,id,options)).complete,false);
    await writeFile(path,encodedFixture()+'{"bad committed JSON":\n');await assert.rejects(collectEvidence(root,id,options),{code:'NATIVE_EVENT_JSON_INVALID'});
    const gap=events.map((e,i)=>i===1?{...e,seq:99}:e);await writeFile(path,[header,...gap].map(v=>JSON.stringify(v)).join('\n')+'\n');
    await assert.rejects(collectEvidence(root,id,options),{code:'NATIVE_SESSION_FORMAT_INVALID'});
    const badTitle=events.map((e,i)=>i===0?{...e,data:{title:'malformed legacy-shape title'}}:e);await writeFile(path,[header,...badTitle].map(v=>JSON.stringify(v)).join('\n')+'\n');
    await assert.rejects(collectEvidence(root,id,options),e=>e.code==='NATIVE_SESSION_FORMAT_INVALID'&&e.format_error.technical_code==='TITLE_MESSAGE_SEQS_MISSING');
    const fingerprint='a'.repeat(64),row={life_id:life,session_id:id,request_id:'a',state:'settled',known_usage:true,model:'flash',reason:'developer_test',input_tokens:128,prompt_cache_hit_tokens:128,prompt_cache_miss_tokens:0,
      prompt_metadata:{system_hash:fingerprint,tools_hash:fingerprint,first_message_hash:fingerprint,reasoning_effort:'high',thinking_mode:'enabled'}};
    const pair=assessCachePair({requests:[row,{...row,request_id:'b'}]},{lifeId:life,sessionId:id});assert(pair.actual_wire_high&&pair.stable_observed_prefix&&pair.exactly_one_attempt_per_request&&pair.all_settled_with_cache_usage);
    assert.equal(assessCachePair({requests:[row,{...row,request_id:'b',prompt_metadata:{...row.prompt_metadata,reasoning_effort:'off'}}]},{lifeId:life,sessionId:id}).actual_wire_high,false);
    const privateFixture=fixture('private_memory_read');
    await writeFile(path,[privateFixture.header,...privateFixture.events].map(v=>JSON.stringify(v)).join('\n')+'\n');
    const privateResult=await collectEvidence(root,id,options);assert.equal(privateResult.final_assistant_text,null);assert.deepEqual(privateResult.events.find(e=>e.type==='tool/result').expected_markers,[]);
    const ledger=join(base,'fixture.sqlite3');
    const script="import sys,sqlite3,json\np,l,s,f=sys.argv[1:]\nc=sqlite3.connect(p)\nc.execute('CREATE TABLE attempts(attempt_id,request_id,session_id,purpose,price_json,usage_json,state,hit,miss,output,calculated,reserved,charged,provider_request_id,started_at,start_day)')\nc.execute('CREATE TABLE request_attribution(attempt_id,life_id,run_id,source_kind,reason,provenance,origin_room_id,provider,model,prompt_metadata_json)')\nfor i in range(2):\n a='TEST-attempt-'+str(i); r='acceptance-rpc-'+str(i+1); h=i*128; m=128-h\n c.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',(a,r,s,'agent-loop',json.dumps({'model':'flash','provider':'deepseek'}),json.dumps({'reasoning_tokens':2}),'settled',h,m,8,200,500,200,'TEST-provider-'+str(i),'2026-10-06T20:0'+str(i)+':00+08:00','2026-10-06'))\n c.execute('INSERT INTO request_attribution VALUES(?,?,?,?,?,?,?,?,?,?)',(a,l,s+':turn:'+str(i+1),'developer-test','developer_test','trusted_native_source',None,'deepseek','flash',json.dumps({'system_hash':f,'tools_hash':f,'first_message_hash':f,'reasoning_effort':'high','thinking_mode':'enabled'})))\nc.commit();c.close()";
    await runFile(pythonDefault,['-c',script,ledger,life,id,fingerprint],{windowsHide:true});const before=hash(await readFile(ledger));
    const actualUsage=await readUsage({sessionId:id,ledgers:[ledger],day:'2026-10-06',requestIds:['acceptance-rpc-1','acceptance-rpc-2']});
    assert.equal(actualUsage.total.requests,2);assert.equal(hash(await readFile(ledger)),before);
    assert.equal(actualUsage.ledgers[0],resolve(ledger));assert(actualUsage.requests.every(row=>row.ledger===resolve(ledger)));
    const actualPair=assessCachePair(actualUsage,{lifeId:life,sessionId:id});assert(actualPair.actual_wire_high&&actualPair.stable_observed_prefix&&actualPair.exactly_one_attempt_per_request&&actualPair.all_settled_with_cache_usage);
    assert.equal(actualPair.sequence[0].attempts[0].cache_hit_rate,0);assert.equal(actualPair.sequence[1].attempts[0].cache_hit_rate,1);
    return {passed:true,checks:['exact-header','identity-mismatch-refused','main-session-refused','unregistered-session-refused','seeded-session-refused','seq-window','unfinished-tail-explicit',
      'official-current-strict-codec','official-generated-seq-zero','snapshot-and-tool-result-replacement','strict-sequence-gap-refused','strict-bad-committed-row-refused','malformed-title-refused',
      'reasoning-and-secrets-omitted','tool-marker-only','private-turn-body-omitted','high-vs-off-assessment','real-read-only-usage-cli','ledger-bytes-unchanged','matched-cache-sequence','unicode-ledger-path-utf8'],paid_calls:0,real_credential_reads:0,real_session_bodies_read:0};
  }finally{await rm(base,{recursive:true,force:true});}
}

async function main(){
  const args=process.argv.slice(2);if(args.length===1&&args[0]==='--self-test')return console.log(JSON.stringify(await selfTest(),null,2));
  const values={roots:[],ledgers:[],requestIds:[]};for(let i=0;i<args.length;i++){
    const name=args[i],value=args[++i];if(value===undefined)fail('CLI_ARGUMENT_VALUE_REQUIRED');
    if(name==='--root')values.root=value;else if(name==='--session-id')values.sessionId=value;else if(name==='--after-seq')values.afterSeq=Number(value);
    else if(name==='--ledger')values.ledgers.push(value);else if(name==='--budget-root')values.roots.push(value);else if(name==='--request-id')values.requestIds.push(value);
    else if(name==='--day')values.day=value;else if(name==='--output')values.output=value;else fail('UNKNOWN_CLI_ARGUMENT');
  }
  if(!values.root||!values.sessionId)fail('ROOT_AND_EXACT_TEST_SESSION_REQUIRED');const native=await collectEvidence(values.root,values.sessionId,{afterSeq:values.afterSeq??0});
  const usage=values.roots.length||values.ledgers.length?await readUsage(values):null;const result={native,usage,cache:usage?assessCachePair(usage,{lifeId:native.binding.life_id,sessionId:values.sessionId,requestIds:values.requestIds}):null};
  const encoded=JSON.stringify(result,null,2)+'\n';if(values.output){await writeFile(resolve(values.output),encoded,{flag:'wx'});console.log(JSON.stringify({written:resolve(values.output),session_id:values.sessionId,complete:native.complete}));}else console.log(encoded);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(JSON.stringify({error:safeId(error.code)??'HOST_ACCEPTANCE_EVIDENCE_FAILED',error_type:safeId(error.name),format_error:error.format_error??null}));process.exitCode=1;});
