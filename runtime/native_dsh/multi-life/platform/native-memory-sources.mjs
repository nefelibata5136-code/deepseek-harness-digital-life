import {mkdir,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {canonical,fail} from '../contracts.mjs';

// Public native query snapshots, not private persistence.locate() or path guesses.
// Native event seq/id remain original; the sidecar explicitly labels derived bytes.
export function createNativeMemorySources({ctx,contexts,locks}) {
  return async context=>{
    const c=contexts.require(context),root=resolve(c.manifest.deployment.memory,'.native-source-snapshots');
    await mkdir(root,{recursive:true});const sources=[];
    for(const row of contexts.registry.sessions(c.lifeId).filter(row=>row.status==='ready')) {
      contexts.target(c,row.sessionId);
      const live=ctx.agents.get(row.sessionId);if(live)await ctx.sessions.flush(live.session);
      const observation=await ctx.sessionQuery.observeSession(row.sessionId);
      let header,events;
      try {
        contexts.registry.assertNative(row.sessionId,observation.header,observation.projections?.values.agentPreset??observation.header.agentPreset);
        header=observation.header;events=[...observation.events];
      }finally{observation[Symbol.dispose]();}
      contexts.require(c);
      const leaf=/^[a-f0-9-]{36}$/i.test(row.sessionId)?row.sessionId:createHash('sha256').update(row.sessionId).digest('hex');
      const path=resolve(root,leaf+'.v4.jsonl'),bytes=[header,...events].map(value=>JSON.stringify(value)).join('\n')+'\n';
      const lease=await locks.acquire(canonical(path).replaceAll('\\','/'),c.sessionId,new AbortController().signal);
      try {
        const temporary=path+'.'+randomUUID()+'.tmp';await writeFile(temporary,bytes);await rename(temporary,path);
        await writeFile(path+'.source.json',JSON.stringify({evidenceKind:'derived-public-native-snapshot',lifeId:c.lifeId,
          originalSessionId:row.sessionId,observedAt:new Date().toISOString(),recordCount:events.length,
          contentHash:createHash('sha256').update(bytes).digest('hex'),originalLocator:'native-session:'+row.sessionId,
          warning:'Physical path is a derived snapshot. Native event seq and source references locate the original journal.'},null,2)+'\n');
      }finally{lease.release();}
      sources.push({sessionId:row.sessionId,path,evidenceKind:'derived-public-native-snapshot'});
    }
    contexts.require(c);return sources;
  };
}
