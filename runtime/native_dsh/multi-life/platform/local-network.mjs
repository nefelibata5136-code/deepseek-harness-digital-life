// Shared native seams over the existing Windows terminal and public search CLI.
// This module adds no Agent loop, shell backend, paid provider or identity selector.
import {spawn} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {applyWebSearchTool} from '@deepseek-ai/dsh-tool-web';
import WebRuntime,{WebError} from '@deepseek-ai/dsh-web';
import {createOfficialSearchProvider} from './official-search.mjs';

export const SEARCH_PROVIDER_ID='digital-life-existing-public-search';
const migrationRoot=resolve(import.meta.dirname,'../../../..');
const defaultSearchScript='.local/workspace/tools/web-search/search.mjs';
const defaultPython=(process.env.DL_PYTHON || 'python');
const defaultTerminalBridge=resolve(migrationRoot,'runtime/workspace_foundation/terminal_bridge.py');
const allowedEnv=new Set(['PATH','SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','PROGRAMFILES','PROGRAMDATA']);
const fail=code=>Object.assign(new Error(code),{code});
const digest=path=>existsSync(path)?createHash('sha256').update(readFileSync(path)).digest('hex'):null;

export function cleanProcessEnvironment(environment=process.env) {
  return {...Object.fromEntries(Object.entries(environment).filter(([name])=>allowedEnv.has(name.toUpperCase()))),
    PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'};
}

// Cancellation waits for the process tree to close. Never expose arbitrary
// child diagnostics; the actual terminal result is the only model-facing body.
export function runJsonProcess({program,args,cwd,input,signal,timeoutMs=100000,maxBytes=1024*1024}) {
  signal?.throwIfAborted();
  return new Promise((accept,reject)=>{
    const child=spawn(program,args,{cwd,env:cleanProcessEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
    let out='',bytes=0,error,stopping=false,timer;
    const stop=code=>{
      if(stopping)return;stopping=true;error=fail(code);
      if(process.platform==='win32'&&child.pid) {
        const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{env:cleanProcessEnvironment(),windowsHide:true,stdio:'ignore'});
        killer.on('error',()=>child.kill());killer.on('close',()=>{if(child.exitCode===null)child.kill();});
      }else child.kill();
    };
    const aborted=()=>stop('LOCAL_OPERATION_CANCELLED');
    signal?.addEventListener('abort',aborted,{once:true});
    timer=setTimeout(()=>stop('LOCAL_OPERATION_TIMEOUT'),timeoutMs);timer.unref();
    child.stdout.setEncoding('utf8');child.stderr.resume();
    child.stdout.on('data',data=>{bytes+=Buffer.byteLength(data);if(bytes>maxBytes)stop('LOCAL_OUTPUT_BOUND_EXCEEDED');else out+=data;});
    child.on('error',()=>{error??=fail('LOCAL_PROCESS_START_FAILED');});
    child.stdin.on('error',()=>{});
    child.on('close',code=>{
      clearTimeout(timer);signal?.removeEventListener('abort',aborted);
      if(error)return reject(error);
      if(code!==0)return reject(fail('LOCAL_PROCESS_FAILED'));
      try{accept(JSON.parse(out));}catch{reject(fail('LOCAL_PROCESS_JSON_INVALID'));}
    });
    child.stdin.end(input===undefined?'':JSON.stringify(input));
    if(signal?.aborted)aborted();
  });
}

function balancedSources(items,maxResults) {
  const groups=new Map(),sources=[],seen=new Set();
  for(const item of items){if(!groups.has(item.src))groups.set(item.src,[]);groups.get(item.src).push(item);}
  for(let rank=0;sources.length<maxResults;rank++) {
    let found=false;
    for(const group of groups.values()) {
      const item=group[rank];if(!item)continue;found=true;
      let url;try{url=new URL(item.url);}catch{throw fail('PUBLIC_SEARCH_RESULT_INVALID');}
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw fail('PUBLIC_SEARCH_RESULT_INVALID');
      if(seen.has(url.href))continue;seen.add(url.href);
      sources.push({url:url.href,...typeof item.title==='string'?{title:item.title}:{},...typeof item.snippet==='string'?{snippet:item.snippet}:{}});
      if(sources.length===maxResults)break;
    }
    if(!found)break;
  }
  return {sources,truncated:items.length>sources.length};
}

export function createExistingSearchProvider({searchScript=defaultSearchScript,runProcess=runJsonProcess}={}) {
  let last=null;
  return {
    id:SEARCH_PROVIDER_ID,
    available:()=>existsSync(searchScript)&&existsSync(resolve(dirname(searchScript),'policy.json')),
    status:()=>({provider_id:SEARCH_PROVIDER_ID,available:existsSync(searchScript)&&existsSync(resolve(dirname(searchScript),'policy.json')),
      implementation:'existing public web-search CLI',source_sha256:digest(searchScript),last_call:last}),
    async search({query,maxResults=8},signal) {
      if(typeof query!=='string'||!query.trim()||query.length>2000||!Number.isSafeInteger(maxResults)||maxResults<1||maxResults>20)throw new WebError('PUBLIC_SEARCH_ARGUMENT_INVALID','PUBLIC_SEARCH_ARGUMENT_INVALID');
      try {
        // A leading space preserves literal queries beginning with --: the
        // established CLI trims query words after parsing only true flags.
        const result=await runProcess({program:process.execPath,args:['--preserve-symlinks-main',searchScript,' '+query,'--json','--n='+maxResults],cwd:dirname(searchScript),signal});
        if(!Array.isArray(result?.items)||!Array.isArray(result?.problems))throw fail('PUBLIC_SEARCH_RESULT_INVALID');
        const projected=balancedSources(result.items,maxResults),observed_at=new Date().toISOString();
        last={observed_at,status:projected.sources.length?'returned_sources':'no_results',source_count:projected.sources.length,problem_count:result.problems.length};
        if(!projected.sources.length&&result.problems.length)throw fail('PUBLIC_SEARCH_BACKENDS_FAILED');
        return {...projected,content:'Search retrieved at '+observed_at+'.'+(result.problems.length?' Partial backend problems: '+result.problems.join('; '):'')};
      }catch(error) {
        const code=/^[A-Z_]+$/.test(error?.code??'')?error.code:'PUBLIC_SEARCH_FAILED';
        last={observed_at:new Date().toISOString(),status:'failed',error_code:code};
        throw new WebError(code,code);
      }
    }
  };
}

export async function mountLocalNetwork(ctx,{ownerFor,searchScript,searchProvider,python=defaultPython,terminalBridge=defaultTerminalBridge,terminal=true,runProcess=runJsonProcess}={}) {
  if(ctx.get?.('digitalLifeLocalNetwork'))throw fail('LOCAL_NETWORK_ALREADY_MOUNTED');
  if(!ctx.get?.('web'))await ctx.plugin(WebRuntime,{});
  const fixture=(ctx.get('multiLifeContexts')??ctx.get('multiLifeOwnership')?.contexts)?.registry.mode==='fixture';
  if(searchScript&&!fixture)throw fail('LOCAL_SEARCH_RETIRED_USE_OFFICIAL');
  if(searchProvider&&!fixture)throw fail('SEARCH_PROVIDER_OVERRIDE_FIXTURE_ONLY');
  const provider=searchProvider??(searchScript&&fixture?createExistingSearchProvider({searchScript,runProcess}):createOfficialSearchProvider(ctx));
  ctx.web.registerSearchProvider(provider);
  const known=new Set(ctx.tools.schemas().map(tool=>tool.name));
  if(!known.has('web_search'))applyWebSearchTool(ctx,8,4,100000,known.has('web_fetch'));
  const addedTerminal=terminal&&!known.has('terminal');
  let lastTerminal=null;
  if(addedTerminal)ctx.tools.register(defineTool({name:'terminal',
    description:'Run necessary commands and tests with the existing Windows terminal. Host fixes cwd to your own workspace; command and optional timeout (1..120 seconds) are the only inputs. Real stdout, stderr and returncode are returned. Normal owner guards still apply; Windows ACL/UAC apply. This is current-user access, not OS isolation.',
    parameters:{command:{type:'string',required:true},timeout:{type:'integer'}},
    output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    timeoutMs:130000,isConcurrencySafe:()=>false,
    async execute(args,exec) {
      const c=(ownerFor??(agent=>ctx.get('multiLifeContexts')?.forAgent(agent)??ctx.get('normalInterfaceOwnership')?.forAgent(agent)))(exec.agent);
      if(!c?.lifeId||c.sessionId!==String(exec.agent?.session.id)||!c.manifest?.deployment?.workspace||c.role==='delegate')throw fail('TRUSTED_TERMINAL_OWNER_REQUIRED');
      if(typeof args.command!=='string'||!args.command.trim()||args.command.length>32768||Object.keys(args).some(key=>!['command','timeout'].includes(key))||args.timeout!==undefined&&(!Number.isSafeInteger(args.timeout)||args.timeout<1||args.timeout>120))throw fail('TERMINAL_ARGUMENT_INVALID');
      if(!existsSync(python)||!existsSync(terminalBridge))throw fail('TERMINAL_BACKEND_UNAVAILABLE');
      try {
        const result=await runProcess({program:python,args:['-B','-X','utf8',terminalBridge,'--workspace',c.manifest.deployment.workspace],cwd:c.manifest.deployment.workspace,input:args,signal:exec.signal,timeoutMs:(args.timeout??30)*1000+15000});
        if(!Number.isInteger(result?.returncode)||typeof result.stdout!=='string'||typeof result.stderr!=='string')throw fail('TERMINAL_RESULT_INVALID');
        lastTerminal={observed_at:new Date().toISOString(),returncode:result.returncode,timeout:result.timeout===true,output_truncated:result.output_truncated===true};return result;
      }catch(error){lastTerminal={observed_at:new Date().toISOString(),error_code:/^[A-Z_]+$/.test(error.code??'')?error.code:'TERMINAL_EXECUTION_FAILED'};throw error;}
    }
  }));
  const service={status:agent=>({search:provider.status(agent),terminal:{implementation:addedTerminal?'existing Windows terminal bridge':'existing registered terminal',
    registered:ctx.tools.schemas(agent).some(tool=>tool.name==='terminal'),backend_available:addedTerminal?existsSync(python)&&existsSync(terminalBridge):null,last_call:lastTerminal}})};
  ctx.provide('digitalLifeLocalNetwork',service);return service;
}
