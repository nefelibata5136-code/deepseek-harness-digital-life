// One native kernel. Stateful fs providers live in isolated preset realms.
// No global environment/fetch edits, no production profile rewrite.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {nativeRequire,native} from '../../workspace_foundation/native.mjs';
import {createFileLocks} from '../../workspace_foundation/file-operation-locks.mjs';
import {LifeContexts} from './context.mjs';
import {LifeRuntime} from './runtime.mjs';
import {fail,canonical,contains,PRIVATE_ROOTS,privatePaths} from './contracts.mjs';
import {ownerDigitalLifePreset} from '../digital-life/preset-foundation.mjs';
import {mountBillingRuntime} from '../../deepseek_billing/service/runtime.mjs';
import {mountV1Runtime} from './platform/v1-runtime.mjs';

const moduleUrl=name=>pathToFileURL(nativeRequire.resolve('@deepseek-ai/'+name)).href;
export async function bootScoped(options) {
  if(options.registry.mode!=='fixture')fail('PRODUCTION_COMPOSITION_NOT_RELEASED');
  return bootLifeKernel(options);
}
export async function bootLifeKernel({registry,root,fixtureRoot,adapter,providerRoutes,sessionRoot=resolve(root,'sessions'),extensions=[],digitalLifePreset=false}) {
  const lives=registry.list();
  if(registry.mode==='fixture') {
    if(!fixtureRoot||JSON.parse(await readFile(resolve(fixtureRoot,'TEST-ONLY.json'),'utf8')).fixture!==true)fail('ISOLATED_FIXTURE_ROOT_REQUIRED');
    const boundary=canonical(fixtureRoot);
    for(const path of [root,sessionRoot,registry.controlRoot,...lives.flatMap(m=>[...privatePaths(m),m.deployment.core,...m.deployment.skillsRoots])])
      if(!contains(boundary,canonical(path)))fail('TEST_FIXTURE_OUTSIDE_BOUNDARY');
  }else if(fixtureRoot)fail('FIXTURE_BOUNDARY_IN_PRODUCTION');
  registry.addControlRoot(root);
  registry.addControlRoot(sessionRoot);
  const {boot}=await native('dsh-app-boot'),{stringify}=await import('yaml');
  await mkdir(root,{recursive:true});
  const names=['cordis-plugin-timer','dsh-llm','dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools','dsh-agent','dsh-agent-loop','dsh-skill','dsh-agent-preset-registry','dsh-session-persistence-jsonl','dsh-session-checkpoint-policy','dsh-session-query','dsh-token-meter','dsh-web','dsh-web-fetch-http','dsh-tool-web'];
  if(!lives.length)fail('EMPTY_RUNTIME_REGISTRY');
  const configs={
    'dsh-system-prompt':{includeHarnessIdentity:false,includeRuntimeContext:false},
    'dsh-tools':{mode:'native'},'dsh-agent-loop':{agents:[]},
    'dsh-agent-preset-registry':{default:lives[0].deployment.presetId},
    'dsh-session-persistence-jsonl':{root:sessionRoot,compression:'none'},
    'dsh-tool-web':{search:false,fetch:true},
  };
  const rows=names.map(name=>({id:name,name:moduleUrl(name),config:configs[name]??{}}));
  rows.push({id:'owner-self-compaction',name:new URL('./compaction.mjs',import.meta.url).href,
    config:{cacheRoot:resolve(root,'compaction-cache')}});
  const configPath=resolve(root,'kernel.yml');await writeFile(configPath,stringify(rows));
  const ctx=await boot(registry.mode==='fixture'?'multi-life-fixture':'multi-life-host',configPath,[],async ctx=>{
    const contexts=new LifeContexts(registry);ctx.provide('multiLifeContexts',contexts);
  });
  try {
    if(!ctx.agents||!ctx.sessions||!ctx.agentPresets)fail('INCOMPLETE_NATIVE_KERNEL');
    if(registry.mode==='production')await mountBillingRuntime(ctx);
    const presets=ctx.agentPresets,agents=ctx.agents;
    ctx.multiLifeContexts.presetOf=agent=>presets.composedPreset(agent.ctx);
    ctx.multiLifeContexts.isLive=agent=>agents.get(agent.session.id)===agent;
    if(adapter)ctx.llm.registerAdapter(providerRoutes,adapter);
    for(const m of lives) {
      const d=m.deployment;
      const declaration={id:d.presetId,name:m.displayName??m.lifeId,plugins:[{
        id:'private-files',name:'cordis:group',group:true,isolate:{fs:true},config:[
          {id:'fs',name:moduleUrl('dsh-fs-local'),config:{cwd:d.workspace}},
          {id:'file-tools',name:moduleUrl('dsh-tool-fs'),config:{}},
          {id:'owner-policy',name:new URL('./scope-policy.mjs',import.meta.url).href,config:{lifeId:m.lifeId,controlRoots:[registry.controlRoot,root],fixtureRoot}},
          {id:'skills-files',name:moduleUrl('dsh-skill-filesystem'),config:{includeDefaultRoots:false,customSkillDirs:d.skillsRoots,watch:registry.mode==='production'}},
          {id:'skill-tool',name:moduleUrl('dsh-tool-skill'),config:{}},
        ]
      }]};
      await ctx.agentPresets.register(digitalLifePreset?ownerDigitalLifePreset(m,declaration):declaration);
    }
    const locks=createFileLocks();ctx.effect(()=>()=>locks.dispose(),'shared file resource broker');
    ctx.on('tools/execute',async(exec,next)=>{
      const c=ctx.multiLifeContexts.execution(exec.agent,{callId:exec.callId});
      ctx.multiLifeContexts.require(c);
      if(!['read','write','edit'].includes(exec.name))return next();
      const fs=ctx.agentPresets.serviceFor(exec.agent,'fs');if(!fs)fail('OWNER_FS_PROVIDER_MISSING');
      const target=await fs.resolve(exec.arguments.file_path,{cwd:exec.agent.session.header.cwd});
      const path=canonical(fs.processPath(target));
      if(['write','edit'].includes(exec.name)) {
        const d=c.manifest.deployment;
        if([d.core,resolve(d.workspace,'memory/continuity.md')].some(document=>path===canonical(document))||['state','memory','vault','recovery'].some(name=>contains(canonical(d[name]),path)))fail('OWNER_STATE_USE_DOMAIN_API');
        const shared=canonical(fileURLToPath(new URL('../../',import.meta.url)));
        if(contains(shared,path)&&!PRIVATE_ROOTS.some(name=>contains(canonical(d[name]),path)))fail('SHARED_RUNTIME_WRITE_REQUIRES_RELEASE');
      }
      const key=path.replaceAll('\\','/');
      if(exec.name==='read')return next();
      const lease=await locks.acquire(key,c.sessionId,exec.signal,{life_id:c.lifeId,tool:exec.name,call_id:exec.callId??null});
      try{return await next();}finally{lease.release();}
    },{prepend:true});
    ctx.on('llm/stream',async function*(options,next){
      const agent=ctx.agents.get(options.sessionId);if(!agent)fail('UNATTRIBUTED_MODEL_REQUEST');
      ctx.multiLifeContexts.forAgent(agent);yield* next();
    },{prepend:true});
    const runtime=new LifeRuntime({ctx,registry,contexts:ctx.multiLifeContexts});
    const host={ctx,runtime,contexts:ctx.multiLifeContexts,locks};
    for(const extend of extensions)await extend(host);
    if(registry.mode==='production')await mountV1Runtime(ctx);
    return host;
  }catch(error){await ctx.fiber.dispose();throw error;}
}
