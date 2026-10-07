// Task-specific checkpoint. Preview is read-only; stale bytes block rollback.
import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
const root=resolve(import.meta.dirname,'..'),report=resolve(root,'../../reports/luna-full-access-20261007');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=['digital-life/codex-advisor.mjs','digital-life/codex-advisor.test.mjs','subagent-router/router.mjs','subagent-router/settings.json','subagent-router/README.md','persona-plugin.mjs','home/profiles/persona/cordis.patch.yml'];
const sealFile=join(report,'seal.json'),mode=process.argv[2]??'--preview';
if(mode==='--seal'){
 const restore=await Promise.all(paths.map(async path=>({path:resolve(root,path),before:join(report,'checkpoint-before',path),sha256:hash(await readFile(resolve(root,path))),before_sha256:hash(await readFile(join(report,'checkpoint-before',path)))})));
 await writeFile(sealFile,JSON.stringify({sealed_at:new Date().toISOString(),restore},null,2),{flag:'wx'});console.log(JSON.stringify({sealed:true,files:restore.length}));
}else if(['--preview','--rollback'].includes(mode)){
 const seal=JSON.parse(await readFile(sealFile,'utf8')),conflicts=[];
 for(const row of seal.restore){if(hash(await readFile(row.before))!==row.before_sha256)throw new Error('CHECKPOINT_BYTES_CHANGED');if(hash(await readFile(row.path))!==row.sha256)conflicts.push(row.path);}
 console.log(JSON.stringify({preview:true,conflicts,restore:seal.restore.map(r=>r.path),reload_required:true,personal_state:'outside scope'},null,2));
 if(conflicts.length){process.exitCode=2;}else if(mode==='--rollback'){
  const backup=join(report,'rollback-before-'+randomUUID());await mkdir(backup,{recursive:true});
  for(let i=0;i<seal.restore.length;i++){const row=seal.restore[i],current=await readFile(row.path);if(hash(current)!==row.sha256)throw new Error('CHECKPOINT_STALE_WRITE');await writeFile(join(backup,i+'.bin'),current,{flag:'wx'});const temp=row.path+'.restore-'+randomUUID();await writeFile(temp,await readFile(row.before),{flag:'wx'});if(hash(await readFile(row.path))!==row.sha256)throw new Error('CHECKPOINT_STALE_WRITE');await rename(temp,row.path);}
  console.log(JSON.stringify({restored:true,backup,reload_required:true}));
 }
}else throw new Error('USE_SEAL_PREVIEW_OR_ROLLBACK');
