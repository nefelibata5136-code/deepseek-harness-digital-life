import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LlmAdapter} from '@deepseek-ai/dsh-llm';
import {stringify} from 'yaml';
import {createFixture} from '../fixture.mjs';
import {LifeRegistry} from '../registry.mjs';
import {bootScoped} from '../boot-scoped.mjs';
import {OwnerBindings} from '../private-services/bindings.mjs';
import {createLifeCapabilityServices} from './capabilities.mjs';
import {registerProfile,withManager,approveProfile} from '../../capabilities/profiles.mjs';
import {OwnerAttachments} from './attachments.mjs';
import {native} from '../../../workspace_foundation/native.mjs';
class Stub extends LlmAdapter {async resolveModel(provider,id){return {provider,id,name:id,context:{contextWindow:100000},defaultMaxTokens:256};}async *stream(){yield {type:'finish',reason:{kind:'stop'}};}}
test('T11/T7: owner-bound credential workers redact synthetic secrets and native file attachments reject foreign references',async()=>{
  const f=await createFixture(['A','B','C','D']),registry=new LifeRegistry({root:f.registryRoot,mode:'fixture'});let host,services;
  try {
    for(const m of f.manifests)registry.register(m);host=await bootScoped({registry,root:f.nativeRoot,fixtureRoot:f.root,adapter:new Stub(),providerRoutes:['TEST-shared-provider']});
    const agents=await Promise.all(f.manifests.map(m=>host.runtime.create({lifeId:m.lifeId,sessionId:m.authoritySessionId,role:'authority'}))),contexts=agents.map(a=>host.contexts.execution(a));
    const bindingRows=new Map(f.manifests.map(m=>[m.lifeId,{accounts:{shared:{accountRef:'TEST-account',kind:'provider',shared:true}},credentials:{fixture:{DL_TEST_SAME_REF:{hostRef:'TEST-host-'+m.lifeId,accountName:'shared'}}}}]));
    const bindings=new OwnerBindings({contexts:host.contexts,bindings:bindingRows}),resolutions=[];
    services=createLifeCapabilityServices({contexts:host.contexts,bindings,credentialBackend:async(c,b,action)=>{
      resolutions.push({lifeId:c.lifeId,sessionId:c.sessionId,hostRef:b.hostRef,action});return action==='resolve'?{value:'TEST-SYNTHETIC-SECRET-'+c.lifeId}:{configured:true};
    }});
    for(const m of f.manifests) {
      const root=m.deployment.capabilities,bundle=resolve(m.deployment.workspace,'TEST-capability-bundle');await mkdir(bundle);
      await writeFile(resolve(bundle,'package.json'),JSON.stringify({name:'test-life-mcp-'+randomUUID(),version:'1.0.0',private:true,dsh:{bundle:{patch:'./cordis.patch.yml'}}}));
      await writeFile(resolve(bundle,'cordis.patch.yml'),stringify([{insert:[{id:'native-mcp',name:resolve(import.meta.dirname,'../../capabilities/mcp-ref.mjs'),config:{transport:'stdio',serverName:'fixture',command:process.execPath,args:[resolve(import.meta.dirname,'../../capabilities/fixture-mcp.mjs')],envRefs:{TEST_TOKEN:'DL_TEST_SAME_REF'},reconnect:{enabled:false}}}]}]));
      await registerProfile(root,{id:'fixture',kind:'mcp',description:'TEST ONLY own credential',credentialRefs:['DL_TEST_SAME_REF']});
      const installed=await withManager(root,'fixture',manager=>manager.installBundle(bundle,{enabled:false}));assert.notEqual(installed.application,'failed');
      await withManager(root,'fixture',manager=>manager.setBundleEnabled(installed.bundle,true));await approveProfile(root,'fixture');
    }
    await Promise.all(contexts.map(c=>services.manage(c,{capability:'fixture',action:'enable'})));
    const results=await Promise.all(contexts.map(c=>services.call(c,{capability:'fixture',name:'mcp__fixture__echo',args:{text:'TEST ONLY scoped call'},callId:randomUUID()})));
    for(const result of results){assert(JSON.stringify(result).includes('[redacted]'));assert(!JSON.stringify(result).includes('TEST-SYNTHETIC-SECRET-'));assert.equal(result.value.structuredContent.parentKeyPresent,false);}
    for(const m of f.manifests)assert(resolutions.some(row=>row.lifeId===m.lifeId&&row.hostRef==='TEST-host-'+m.lifeId&&row.action==='resolve'));
    const second=await host.runtime.create({lifeId:contexts[0].lifeId,role:'activity'}),secondContext=host.contexts.execution(second),beforeConcurrent=resolutions.length;
    await Promise.all([services.list(contexts[0]),services.list(secondContext)]);
    const descriptions=resolutions.slice(beforeConcurrent).filter(row=>row.action==='describe');
    assert(descriptions.some(row=>row.sessionId===contexts[0].sessionId));assert(descriptions.some(row=>row.sessionId===secondContext.sessionId));
    const originalScope=host.ctx.isolate('attachments');await originalScope.plugin((await native('dsh-attachment-local')).default,{dshHome:dirname(f.manifests[0].deployment.attachments)}).await();
    const originalRef=await originalScope.attachments.saveFile({data:Buffer.from('TEST ONLY PREEXISTING NATIVE ATTACHMENT'),name:'original.txt'});
    const attachments=new OwnerAttachments(host),refs=await Promise.all(contexts.map((c,i)=>attachments.saveFile(c,{data:Buffer.from('TEST ONLY PRIVATE FILE '+i),name:'same-name.txt'})));
    assert.equal((await attachments.readFile(contexts[0],{lifeId:contexts[0].lifeId,kind:'file',attachment:originalRef})).toString(),'TEST ONLY PREEXISTING NATIVE ATTACHMENT');
    for(const [i,c] of contexts.entries())assert.equal((await attachments.readFile(c,refs[i])).toString(),'TEST ONLY PRIVATE FILE '+i);
    await assert.rejects(attachments.readFile(contexts[1],refs[0]),/ATTACHMENT_OWNER_MISMATCH/);
    await assert.rejects(attachments.readFile(contexts[1],{...refs[0],lifeId:contexts[1].lifeId}),error=>error.name==='AttachmentError');
    const cache=resolve(dirname(f.manifests[0].deployment.attachments),'cache','attachments');
    await assert.rejects(host.ctx.agentPresets.serviceFor(agents[1],'fs').resolve(cache),/OTHER_LIFE_PRIVATE_RESOURCE/);
    await writeFile(new URL('../../../../reports/multi-life-implementation-20261006/capabilities-validation.json',import.meta.url),JSON.stringify({passed:true,observedAt:new Date().toISOString(),ownerWorkers:4,sameLogicalRefDifferentHostBindings:true,sameOwnerConcurrentSessionCredentialAttribution:true,workerResultsRedacted:true,parentProviderCredentialAbsent:true,nativeFilesOwnerBound:true,preexistingNativeAttachmentReused:true,attachmentCacheOwnerGuarded:true,paidCalls:0,realCredentialStoreAccessed:false},null,2)+'\n');
  }finally{await services?.dispose();if(host)await host.ctx.fiber.dispose();registry.close();await f.cleanup();}
});
