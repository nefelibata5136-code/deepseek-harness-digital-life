// Official DSH search implementation; Host owns identity, credentials and accounting.
// No search subprocess, fallback backend, prompt-derived owner or vendor patch.
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash,randomUUID} from 'node:crypto';
import {DeepSeekSearchProvider,DEEPSEEK_PROVIDER_ID} from '@deepseek-ai/dsh-web-search-deepseek';
import {credentialRefForLife} from '../budget/credentials.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {wirePromptMetadata} from '../budget/provenance.mjs';

const requests=new AsyncLocalStorage();
export const SEARCH_PROVIDER_ID=DEEPSEEK_PROVIDER_ID;
export const SEARCH_ENDPOINT='https://api.deepseek.com/anthropic/v1/messages';
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};

export function createOfficialSearchProvider(ctx,{contexts=ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts,
  resolveKey=async c=>(await credentialOperation('python','resolve',credentialRefForLife(c.lifeId))).value}={}) {
  if(!contexts?.execution)fail('SEARCH_TRUSTED_CONTEXTS_REQUIRED');
  const last=new Map(),toolOwners=new AsyncLocalStorage();
  ctx.on('tools/execute',(exec,next)=>toolOwners.run(exec.agent,next),{prepend:true});
  return {
    id:SEARCH_PROVIDER_ID,available:()=>true,
    status:agent=>({provider_id:SEARCH_PROVIDER_ID,available:true,implementation:'@deepseek-ai/dsh-web-search-deepseek',
      model:'deepseek-flash',endpoint:SEARCH_ENDPOINT,local_script_enabled:false,last_call:agent?last.get(contexts.forAgent(agent).lifeId)??null:null}),
    async search(request,signal) {
      const agent=toolOwners.getStore()??ctx.agents.currentInitiator();if(!agent)fail('SEARCH_NATIVE_INITIATOR_REQUIRED');
      const c=contexts.execution(agent,{requestId:randomUUID()});contexts.require(c);
      const state={c,agent,requestId:c.requestId,last};
      const provider=new DeepSeekSearchProvider(()=>({baseURL:'https://api.deepseek.com/anthropic/v1',model:'deepseek-flash',
        apiVersion:'2023-06-01',maxTokens:4096,maxUses:5,
        resolveApiKey:async()=>{contexts.require(c);return resolveKey(c);},
        recordRequest:({body})=>agent.session.append('web/deepseek-search-llm-request',{
          phase:'request',provider:SEARCH_PROVIDER_ID,life_id:c.lifeId,session_id:c.sessionId,request_id:c.requestId,
          endpoint:SEARCH_ENDPOINT,model:body.model,max_tokens:body.max_tokens,...wirePromptMetadata(body)})}));
      try {
        const result=await requests.run(state,()=>provider.search(request,signal));
        last.set(c.lifeId,{observed_at:new Date().toISOString(),status:'returned_sources',source_count:result.sources.length,request_id:c.requestId});
        return result;
      }catch(error) {
        last.set(c.lifeId,{observed_at:new Date().toISOString(),status:'failed',error_code:error.code??'WEB_PROVIDER_ERROR',request_id:c.requestId});
        throw error;
      }
    }
  };
}

// Called by both existing provider-domain brokers. Only this module's trusted
// async scope can admit the official auxiliary request; ordinary model guard
// rules remain intact. Account settlement uses the existing owner ledger.
export function hasOfficialSearchContext(){return requests.getStore()!==undefined;}
export async function dispatchOfficialSearch(input,init,{transport,rpc,screenRequest}={}) {
  const state=requests.getStore();if(!state)fail('SEARCH_TRUSTED_CONTEXT_REQUIRED');
  const {c,agent}=state;
  if(String(input)!==SEARCH_ENDPOINT||init?.method!=='POST'||typeof init.body!=='string')fail('SEARCH_WIRE_ENVELOPE_INVALID');
  const body=JSON.parse(init.body);
  if(body.model!=='deepseek-flash'||body.stream!==undefined||body.max_tokens!==4096||body.tools?.length!==1||
    body.tools[0].type!=='web_search_20250305'||body.tools[0].name!=='web_search'||body.tools[0].max_uses!==5||
    body.messages?.length!==1||Object.keys(body).some(k=>!['model','max_tokens','messages','tools'].includes(k)))fail('SEARCH_WIRE_SHAPE_INVALID');
  if(typeof rpc!=='function'||typeof transport!=='function')fail('SEARCH_ACCOUNTING_REQUIRED');
  await screenRequest?.(input,init);
  const id=randomUUID(),attribution={life_id:c.lifeId,run_id:c.runId,reason:c.costCategory,source_kind:c.sourceKind??null,
    provenance:c.costProvenance??'trusted_owner_source_unknown',origin_room_id:c.origin_room_id??null};
  const admitted=await rpc(c,'reserve',{attempt_id:id,request_id:c.requestId,session_id:c.sessionId,purpose:c.costCategory,
    provider:'deepseek-official',model:body.model,owner_pid:process.pid,max_tokens:body.max_tokens,payload_hash:hash(init.body),
    attribution,prompt_metadata:wirePromptMetadata(body)});
  if(admitted.allowed!==true||!Number.isSafeInteger(admitted.max_tokens)||admitted.max_tokens<2)fail('SEARCH_ADMISSION_FAILED');
  body.max_tokens=admitted.max_tokens-1;const outgoing=JSON.stringify(body);
  await rpc(c,'bind',{attempt_id:id,max_tokens:body.max_tokens,output_headroom_tokens:1,wire_hash:hash(outgoing)});
  let dispatched=false;
  try {
    dispatched=true;
    const response=await transport(input,{...init,body:outgoing,redirect:'error'});
    if(!response.ok){await rpc(c,'unknown',{attempt_id:id,reason:'search_http_error_usage_unknown'});return response;}
    const parsed=await response.clone().json();
    const rawId=response.headers.get('request-id')??response.headers.get('x-request-id')??parsed.id;
    const providerId=typeof rawId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_./-]{0,255}$/.test(rawId)&&!rawId.startsWith('sk-')?rawId:null;
    await rpc(c,'settle',{attempt_id:id,usage:parsed.usage,provider_request_id:providerId});
    agent.session.append('web/deepseek-search-llm-request',{phase:'usage',life_id:c.lifeId,session_id:c.sessionId,request_id:c.requestId,
      attempt_id:id,provider_request_id:providerId,usage:parsed.usage,accounting:'existing-owner-ledger',
      local_estimate_is_provider_debit:false});
    return response;
  }catch(error){if(dispatched)await rpc(c,'unknown',{attempt_id:id,reason:'search_transport_or_usage_unknown'});throw error;}
}
