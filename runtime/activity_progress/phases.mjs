import {appendFile,mkdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {phaseLabels,VERSION} from './events.mjs';
// Separate diagnostic journal: stable IDs, no arguments, paths, results or text.
export function createPhaseJournal(root) {
  let tail=Promise.resolve(),failures=0;
  const valid=id=>/^[a-f0-9-]{36}$/i.test(id);
  const file=id=>resolve(root,id+'.jsonl');
  const queued=new Map();
  return {
    record(sessionId,callId,phase) {
      if(!valid(sessionId)||!phaseLabels[phase]||typeof callId!=='string')return;
      const now=Date.now();
      const value={id:randomUUID(),sessionId,callId,phase,source:'host-tool-lifecycle',occurredAt:now,observedAt:now,version:VERSION};
      value.contentHash=createHash('sha256').update(JSON.stringify(value)).digest('hex');
      const rows=queued.get(sessionId)??[];rows.push(value);queued.set(sessionId,rows);
      tail=tail.then(async()=>{await mkdir(root,{recursive:true});await appendFile(file(sessionId),JSON.stringify(value)+'\n','utf8');
        const pending=queued.get(sessionId);const i=pending.indexOf(value);if(i>=0)pending.splice(i,1);
      }).catch(()=>{failures++;});
    },
    async read(sessionId) {
      if(!valid(sessionId))throw Error('Invalid activity Session');
      // Capture pending before the read: a concurrent append may finish between
      // reading disk and collecting current pending events. Merge by stable ID.
      const pending=[...(queued.get(sessionId)??[])];
      let text='';try{text=await readFile(file(sessionId),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
      const stored=text.slice(0,text.lastIndexOf('\n')+1).split('\n').filter(Boolean).map(JSON.parse);
      const rows=[...stored,...pending,...(queued.get(sessionId)??[])];
      return {version:VERSION,events:[...new Map(rows.map(r=>[r.id,r])).values()],recordingErrors:failures,observedAt:Date.now()};
    },
    flush:()=>tail,
  };
}
