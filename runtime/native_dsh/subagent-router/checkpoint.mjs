import {readFile,writeFile,mkdir,readdir,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const nativeRoot=resolve(import.meta.dirname,'..'),report=resolve(nativeRoot,'../../reports/luna-default-20261006');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const original=['digital-life/codex-advisor.mjs','multi-life/runtime.mjs','multi-life/platform/mount.mjs','home/profiles/persona/cordis.patch.yml','persona-plugin.mjs'];
const mapping=original.map(path=>({path:resolve(nativeRoot,path),before:join(report,'checkpoint-before',path)}));
mapping.push({path:'.local/workspace/capabilities.md',before:join(report,'checkpoint-before/persona-capabilities.md')},
 {path:'.local/lives/life-f422ba76-d026-5363-83a1-552ea830106d/workspace/AGENTS.md',before:join(report,'checkpoint-before/newlife-AGENTS.md')});
const sealFile=join(report,'seal.json'),mode=process.argv[2]??'--preview';
if(mode==='--seal'){
 const paths=[...mapping.map(r=>r.path),...(await readdir(import.meta.dirname)).filter(f=>/\.(mjs|json|md)$/.test(f)).map(f=>join(import.meta.dirname,f))];
 const hashes=Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
 const restore=await Promise.all(mapping.map(async r=>({...r,before_sha256:hash(await readFile(r.before))})));
 await writeFile(sealFile,JSON.stringify({sealed_at:new Date().toISOString(),hashes,restore},null,2),{flag:'wx'});
 console.log(JSON.stringify({sealed:true,file:sealFile,files:paths.length}));
}else if(['--preview','--rollback'].includes(mode)){
 const seal=JSON.parse(await readFile(sealFile,'utf8')),conflicts=[];
 for(const [path,expected]of Object.entries(seal.hashes)){let actual;try{actual=hash(await readFile(path));}catch{actual='missing';}if(actual!==expected)conflicts.push({path,expected,actual});}
 for(const row of seal.restore)if(hash(await readFile(row.before))!==row.before_sha256)throw new Error('CHECKPOINT_BYTES_CHANGED');
 console.log(JSON.stringify({preview:true,conflicts,restore:seal.restore.map(r=>r.path),new_router_sources:'retained; not deleted',protected_personal_state:'outside rollback scope'},null,2));
 if(conflicts.length){process.exitCode=2;}
 else if(mode==='--rollback'){
  const backup=join(report,'rollback-before-'+randomUUID());await mkdir(backup,{recursive:true});
  for(let i=0;i<seal.restore.length;i++){
   const row=seal.restore[i],current=await readFile(row.path);
   if(hash(current)!==seal.hashes[row.path])throw new Error('CHECKPOINT_STALE_WRITE');
   await writeFile(join(backup,i+'.bin'),current,{flag:'wx'});
   const tmp=row.path+'.restore-'+randomUUID();await writeFile(tmp,await readFile(row.before),{flag:'wx'});
   if(hash(await readFile(row.path))!==seal.hashes[row.path])throw new Error('CHECKPOINT_STALE_WRITE');
   await rename(tmp,row.path);
  }
  console.log(JSON.stringify({restored:true,backup,reload_required:true}));
 }
}else throw new Error('USE_SEAL_PREVIEW_OR_ROLLBACK');
