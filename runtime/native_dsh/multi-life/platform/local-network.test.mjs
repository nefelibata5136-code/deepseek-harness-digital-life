import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {defineTool} from '@deepseek-ai/dsh-tools';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {mountNormalInterfaceOwnership} from './normal-interface-ownership.mjs';
import {cleanProcessEnvironment,createExistingSearchProvider,runJsonProcess,mountLocalNetwork} from './local-network.mjs';

test('child environment excludes injected service credentials',()=>{
  const result=cleanProcessEnvironment({PATH:'TEST ONLY PATH',SYSTEMROOT:'TEST ONLY ROOT',DEEPSEEK_API_KEY:'TEST SECRET',DASHSCOPE_API_KEY:'TEST SECRET',CUSTOM_SECRET:'TEST SECRET'});
  assert.deepEqual(result,{PATH:'TEST ONLY PATH',SYSTEMROOT:'TEST ONLY ROOT',PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'});
});

test('JSON transport reports real exit, bounded output and cancellation without arbitrary diagnostics',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'v1-local-process-'));
  try {
    const success=await runJsonProcess({program:process.execPath,args:['-e','process.stdout.write(JSON.stringify({real:2+3}))'],cwd:dir});
    assert.deepEqual(success,{real:5});
    await assert.rejects(runJsonProcess({program:process.execPath,args:['-e','process.stderr.write("PRIVATE DIAGNOSTIC");process.exit(7)'],cwd:dir}),e=>e.code==='LOCAL_PROCESS_FAILED'&&!e.message.includes('PRIVATE'));
    await assert.rejects(runJsonProcess({program:process.execPath,args:['-e','process.stdout.write("x".repeat(1000))'],cwd:dir,maxBytes:100}),e=>e.code==='LOCAL_OUTPUT_BOUND_EXCEEDED');
    const controller=new AbortController(),pending=runJsonProcess({program:process.execPath,args:['-e','setInterval(()=>{},1000)'],cwd:dir,signal:controller.signal});
    setTimeout(()=>controller.abort(),100);await assert.rejects(pending,e=>e.code==='LOCAL_OPERATION_CANCELLED');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('search uses literal query arguments, balances sources, keeps partial failure and fails total outage',async()=>{
  const dir=await mkdtemp(resolve(tmpdir(),'v1-search-provider-')),script=resolve(dir,'search.mjs');
  await writeFile(script,'TEST ONLY SCRIPT');await writeFile(resolve(dir,'policy.json'),'{}');
  let args,mode='partial';
  const provider=createExistingSearchProvider({searchScript:script,runProcess:async request=>{
    args=request.args;
    return mode==='partial'?{items:[{src:'bing',url:'https://example.com/1',title:'TEST A'},{src:'bing',url:'https://example.com/2'},{src:'hn',url:'https://example.com/3',snippet:'TEST HN'}],problems:['TEST ONLY unavailable SE']}
      :mode==='bad-url'?{items:[{src:'bing',url:'file:///private'}],problems:[]}:{items:[],problems:['TEST ONLY HTTP 403']};
  }});
  try {
    assert(provider.available());
    const result=await provider.search({query:'--page=https://example.com',maxResults:2});
    assert.equal(args[2],' --page=https://example.com');assert.deepEqual(result.sources.map(s=>s.url),['https://example.com/1','https://example.com/3']);assert(result.truncated);assert.match(result.content,/Partial backend/);
    mode='offline';await assert.rejects(provider.search({query:'TEST ONLY'}),e=>e.code==='PUBLIC_SEARCH_BACKENDS_FAILED');assert.equal(provider.status().last_call.status,'failed');
    mode='bad-url';await assert.rejects(provider.search({query:'TEST ONLY'}),e=>e.code==='PUBLIC_SEARCH_RESULT_INVALID');
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('official schemas and guarded direct terminal use owner workspace; native writes and real tests form a fixture loop',async()=>{
  const f=await createFixture(['LOCAL-NETWORK-A','LOCAL-NETWORK-B']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host;
  try {
    for(const m of f.manifests)registry.register(m);
    const script=resolve(f.root,'search.mjs');await writeFile(resolve(f.root,'policy.json'),'{}');
    await writeFile(script,'console.log(JSON.stringify({items:[{src:"bing",title:"TEST ONLY source",url:"https://example.com/today",snippet:"TEST ONLY changing fixture fact"}],problems:[]}))');
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>{
      await mountLocalNetwork(h.ctx,{ownerFor:agent=>h.contexts.forAgent(agent),searchScript:script});
      mountNormalInterfaceOwnership(h.ctx,{registry,contexts:h.contexts,manifests:()=>registry.list()});
    }]});
    const A=f.manifests[0],B=f.manifests[1],agent=await host.runtime.create({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'});
    const call=(name,args)=>host.ctx.tools.execute({agent,name,arguments:args,callId:randomUUID(),signal:new AbortController().signal});
    const names=host.ctx.tools.schemas(agent).map(t=>t.name);assert(names.includes('terminal'));assert(names.includes('web_search'));assert(names.includes('web_fetch'));
    const schema=host.ctx.tools.schemas(agent).find(t=>t.name==='terminal');assert.deepEqual(schema.parameters.required,['command']);assert.deepEqual(Object.keys(schema.parameters.properties),['command','timeout']);
    const search=await call('web_search',{queries:['TEST ONLY today']});assert.equal(search.isError,false,JSON.stringify(search));assert(JSON.stringify(search).includes('https://example.com/today'));
    const denied=await call('terminal',{command:'type "'+resolve(B.deployment.workspace,'same-name.txt')+'"'});assert(denied.isError);assert.match(JSON.stringify(denied),/OTHER_LIFE_PRIVATE_RESOURCE/);
    const bad=await call('terminal',{command:'echo TEST',timeout:999});assert(bad.isError);assert.match(JSON.stringify(bad),/TERMINAL_ARGUMENT_INVALID/);
    const file=resolve(A.deployment.workspace,'necessary-test.cjs');
    assert.equal((await call('write',{file_path:file,content:'const assert=require("node:assert/strict");assert.equal(2+2,5);console.log("FIXTURE_LOOP_PASS");'})).isError,false);
    assert(JSON.stringify(await call('read',{file_path:file})).includes('2+2,5'));
    if(process.platform==='win32') {
      const initial=await call('terminal',{command:'node necessary-test.cjs',timeout:15});assert.equal(initial.isError,false,JSON.stringify(initial));assert.notEqual(initial.value.returncode,0);
      assert.equal((await call('edit',{file_path:file,old_string:'assert.equal(2+2,5)',new_string:'assert.equal(2+2,4)'})).isError,false);
      const fixed=await call('terminal',{command:'node necessary-test.cjs',timeout:15});assert.equal(fixed.isError,false,JSON.stringify(fixed));assert.equal(fixed.value.returncode,0);assert.match(fixed.value.stdout,/FIXTURE_LOOP_PASS/);assert.equal(fixed.value.workspace,resolve(A.deployment.workspace));
      assert.equal(host.ctx.get('digitalLifeLocalNetwork').status(agent).terminal.last_call.returncode,0);
    }
    assert.equal(await readFile(resolve(B.deployment.workspace,'same-name.txt'),'utf8'),'TEST ONLY FILE LOCAL-NETWORK-B\n');
  }finally{await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});

test('mount preserves an existing registered terminal implementation',async()=>{
  const f=await createFixture(['LOCAL-NETWORK-PRESERVE']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host;
  try {
    registry.register(f.manifests[0]);
    host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,extensions:[async h=>{
      h.ctx.tools.register(defineTool({name:'terminal',description:'TEST ONLY prior backend',parameters:{command:{type:'string',required:true}},output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>({existing:true})}));
      await mountLocalNetwork(h.ctx,{ownerFor:agent=>h.contexts.forAgent(agent)});
    }]});
    const A=f.manifests[0],agent=await host.runtime.create({lifeId:A.lifeId,sessionId:A.authoritySessionId,role:'authority'});
    const result=await host.ctx.tools.execute({agent,name:'terminal',arguments:{command:'TEST ONLY'},callId:randomUUID(),signal:new AbortController().signal});
    assert.equal(result.isError,false,JSON.stringify(result));assert.deepEqual(result.value,{existing:true});assert.equal(host.ctx.get('digitalLifeLocalNetwork').status(agent).terminal.implementation,'existing registered terminal');
  }finally{await host?.ctx.fiber.dispose();registry.close();await f.cleanup();}
});
