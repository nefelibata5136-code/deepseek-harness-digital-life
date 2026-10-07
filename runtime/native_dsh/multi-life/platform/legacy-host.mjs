import {randomUUID} from 'node:crypto';
import {canonical,fail} from '../contracts.mjs';
import {LifeContexts} from '../context.mjs';

// Compatibility composition only: old global plugins remain bound to ONE verified
// legacy owner. A separate N-way composition must not reuse their singleton hooks.
// Register from native boot.prepare; dependencies activate before Agent creation.
export function prepareLegacyOwnership(ctx,{registry,manifest,adoptSessionIds=[manifest.authoritySessionId],simulateLegacy=false,nativeRoot}) {
  if(registry.list().length!==1||registry.life(manifest.lifeId).lifeId!==manifest.lifeId||
    !(manifest.kind==='legacy'||simulateLegacy&&registry.mode==='fixture'&&manifest.kind==='fixture'))fail('LEGACY_COMPOSITION_SINGLE_OWNER_REQUIRED');
  if(nativeRoot)registry.addControlRoot(nativeRoot);
  const contexts=new LifeContexts(registry);ctx.provide('multiLifeContexts',contexts);
  ctx.plugin({name:'legacy-session-owner-boundary',inject:['agents','sessionQuery','agentPresets','sessions'],async apply(child){
    const agents=child.agents,presets=child.agentPresets;
    contexts.presetOf=agent=>presets.composedPreset(agent.ctx);contexts.isLive=agent=>agents.get(agent.session.id)===agent;
    // Only caller-selected ids are adopted. Same cwd does not grant ownership.
    for(const id of adoptSessionIds) {
      let observation;
      try{observation=await child.sessionQuery.observeSession(id);}catch(error){if(error.code!=='SESSION_QUERY_SESSION_NOT_FOUND')throw error;}
      if(!observation){if(id!==manifest.authoritySessionId)fail('LEGACY_IMPORT_SOURCE_MISSING');registry.reserve({lifeId:manifest.lifeId,sessionId:id,role:'authority'});continue;}
      try {
        const h=observation.header,selected=observation.projections?.values.agentPreset??h.agentPreset;
        if(canonical(h.cwd)!==canonical(manifest.deployment.workspace)||(selected!==undefined&&selected!==manifest.deployment.presetId))fail('LEGACY_IMPORT_BINDING_MISMATCH');
        const delegate=(h.delegationDepth??0)>0,source=h.parentSession&&!delegate?h.parentSession:null;
        registry.reserve({lifeId:manifest.lifeId,sessionId:id,role:id===manifest.authoritySessionId?'authority':delegate?'delegate':'activity',
          parentSessionId:delegate?h.parentSession:null,sourceSessionId:source,legacyHeaderPresetAbsentVerified:h.agentPreset===undefined});
        registry.complete(id,h,selected??manifest.deployment.presetId);
      }finally{observation[Symbol.dispose]();}
    }
    const originals={create:agents.create,resume:agents.resume};
    const wrap=method=>async function(options) {
      const id=method==='resume'?options.resumeSessionId:options.sessionId??randomUUID();
      let row;
      try{row=registry.owner(id);}catch(error){
        if(error.code!=='UNKNOWN_SESSION_OWNER')throw error;
        if(method==='create'&&options.parentAgent) {
          const parent=contexts.forAgent(options.parentAgent);
          row=registry.reserve({lifeId:parent.lifeId,sessionId:id,role:'delegate',parentSessionId:parent.sessionId});
        }else if(method==='create'&&options.meta?.isSeeded===true&&options.meta.parentSession) {
          const source=registry.owner(options.meta.parentSession);
          row=registry.reserve({lifeId:source.lifeId,sessionId:id,role:'activity',sourceSessionId:source.sessionId});
        }else throw error;
      }
      if(row.lifeId!==manifest.lifeId)fail('LEGACY_API_OWNER_MISMATCH');
      const setup=options.setup;
      const result=await originals[method].call(this,{...options,...method==='create'?{sessionId:id}:{},setup:async(agentCtx,agent)=>{
        registry.assertNative(id,agent.session.header);contexts.bind(agent);
        const outcome=await setup?.(agentCtx,agent);
        return {...outcome,commit:()=>{outcome?.commit?.();contexts.forAgent(agent);}};
      }});
      await child.sessions.flush(result.agent.session);registry.complete(id,result.agent.session.header,presets.composedPreset(result.agent.ctx));return result;
    };
    agents.create=wrap('create');agents.resume=wrap('resume');
    child.effect(()=>()=>{agents.create=originals.create;agents.resume=originals.resume;},'legacy public factory owner guard');
    child.on('llm/stream',async function*(options,next){const agent=agents.get(options.sessionId);if(!agent)fail('UNATTRIBUTED_MODEL_REQUEST');contexts.forAgent(agent);yield* next();},{prepend:true});
    child.provide('multiLifeOwnership',{registry,contexts,legacyLifeId:manifest.lifeId,composition:'legacy-only',productionNWayReleased:false});
  }});
  ctx.plugin({name:'legacy-task-owner-boundary',inject:['personaTasks','multiLifeOwnership','sessionQuery'],apply(child){
    const tasks=child.personaTasks,original={create:tasks.create,accepts:tasks.accepts,list:tasks.list};
    tasks.create=async({sessionId=randomUUID(),...args}={})=>{
      let known=false;try{registry.owner(sessionId);known=true;}catch(error){if(error.code!=='UNKNOWN_SESSION_OWNER')throw error;}
      if(!known&&(await child.sessionQuery.listSessions()).some(row=>row.header.id===sessionId))fail('LEGACY_SESSION_EXPLICIT_IMPORT_REQUIRED');
      registry.reserve({lifeId:manifest.lifeId,sessionId,role:'activity'});return original.create({sessionId,...args});
    };
    tasks.accepts=async id=>{try{registry.assertTarget(manifest.lifeId,id);return await original.accepts(id);}catch(error){if(['UNKNOWN_SESSION_OWNER','SESSION_OWNER_MISMATCH'].includes(error.code))return false;throw error;}};
    tasks.list=async()=>{const rows=await original.list();return rows.filter(row=>{try{return registry.owner(row.sessionId).lifeId===manifest.lifeId;}catch{return false;}});};
    child.effect(()=>()=>Object.assign(tasks,original),'legacy task owner boundary');
  }});
  return contexts;
}
