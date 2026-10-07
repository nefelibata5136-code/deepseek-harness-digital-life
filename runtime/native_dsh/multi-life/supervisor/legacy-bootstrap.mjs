import {readdir,open,writeFile,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {inspectLegacy} from '../legacy.mjs';
import {canonical,fail} from '../contracts.mjs';
import {workerRegistry,worldRoot,migrationRoot,privacyManifests,privateControlRoots} from './deployment.mjs';
import {mountNormalInterfaceOwnership} from '../platform/normal-interface-ownership.mjs';
import {mountHighTestOverride} from './reasoning.mjs';
import {provenanceForAgent} from '../budget/provenance.mjs';
import {createSharedResourceClient} from '../platform/shared-resource-client.mjs';
import {createWorkerControlTransport} from '../platform/legacy-worker.mjs';
import {credentialOperation} from '../../capabilities/isolation.mjs';
import {workerReference} from './neutral.mjs';
import {python} from './deployment.mjs';
import {mountV1Runtime} from '../platform/v1-runtime.mjs';

// Explicit migration import from the original owner's deployed native store.
// A matching cwd outside this named store never grants owner membership.
export async function prepareProductionLegacyOwner() {
  const manifest=await inspectLegacy({migrationRoot}),registry=await workerRegistry(manifest.lifeId,{legacyOnly:true});
  const nativeRoot=resolve(migrationRoot,'runtime/native_dsh/home/sessions'),headers=[];
  async function visit(directory) {
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=resolve(directory,entry.name);
      if(entry.isDirectory())await visit(path);
      else if(entry.isFile()&&entry.name==='session.v4.jsonl') {
        const fd=await open(path,'r');let text;try{const buffer=Buffer.alloc(65536);const {bytesRead}=await fd.read(buffer,0,buffer.length,0);text=buffer.subarray(0,bytesRead).toString('utf8').split('\n')[0];}finally{await fd.close();}
        const h=JSON.parse(text);
        if(h.type!=='session'||canonical(h.cwd)!==canonical(manifest.deployment.workspace)||h.agentPreset!==undefined&&h.agentPreset!=='persona')continue;
        headers.push(h);
      }
    }
  }
  await visit(nativeRoot);headers.sort((a,b)=>(a.createdAt??0)-(b.createdAt??0));
  // The import binds trusted headers without replaying every private journal.
  // Actual create/resume still validates the native preset and fingerprint.
  for(const h of headers) {
    const role=h.id===manifest.authoritySessionId?'authority':(h.delegationDepth??0)>0?'delegate':'activity';
    registry.reserve({lifeId:manifest.lifeId,sessionId:h.id,role,parentSessionId:role==='delegate'?h.parentSession:null,
      sourceSessionId:role!=='delegate'&&h.isSeeded&&h.parentSession?h.parentSession:null,
      legacyHeaderPresetAbsentVerified:h.agentPreset===undefined});
    registry.complete(h.id,h,h.agentPreset??manifest.deployment.presetId);
  }
  const ids=[manifest.authoritySessionId,...headers.map(h=>h.id).filter(id=>id!==manifest.authoritySessionId)];
  const folder=resolve(worldRoot,'workers',manifest.lifeId);await mkdir(folder,{recursive:true});
  const proof=resolve(folder,'legacy-owner-import.json');
  await writeFile(proof,JSON.stringify({schema_version:1,life_id:manifest.lifeId,native_store:nativeRoot,
    source:'explicit-original-owner-store-import',session_ids:ids,observed_at:new Date().toISOString()},null,2)+'\n');
  const {value:token}=await credentialOperation(python,'resolve',workerReference(manifest.lifeId));if(!token)fail('WORKER_CREDENTIAL_UNAVAILABLE');
  const marker=JSON.parse(await readFile(resolve(worldRoot,'birth.json'),'utf8'));
  const resources=createSharedResourceClient({rpc:createWorkerControlTransport('http://127.0.0.1:'+marker.port,manifest.lifeId,token),lifeId:manifest.lifeId});
  return {registry,manifest,adoptSessionIds:[],nativeRoot,resources};
}
export async function mountProductionLegacyBoundaries(ctx,binding) {
  const service=ctx.get('multiLifeOwnership');if(!service||service.legacyLifeId!==binding.manifest.lifeId)fail('LEGACY_TRUSTED_OWNER_NOT_READY');
  mountNormalInterfaceOwnership(ctx,{registry:binding.registry,contexts:service.contexts,ownerLifeId:binding.manifest.lifeId,
    manifests:privacyManifests,controlRoots:privateControlRoots,protectedWriteRoots:[resolve(migrationRoot,'runtime')],acquireResource:binding.resources.acquire});
  ctx.provide('personaCostIdentity',{resolve:(_options,agent)=>{
    const c=service.contexts.forAgent(agent);return provenanceForAgent(agent,{lifeId:c.lifeId,role:c.role});
  }});
  const reasoning=mountHighTestOverride(ctx,{lifeId:binding.manifest.lifeId,path:resolve(worldRoot,'supervisor/test-reasoning.json')});
  ctx.provide('multiLifeWorkerMetrics',reasoning);
  ctx.effect(()=>()=>binding.registry.close(),'legacy worker owner mirror');
  await mountV1Runtime(ctx);
  return service;
}
