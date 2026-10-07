import {readFile,writeFile,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=import.meta.dirname;
const generation=process.argv[2]??'';
if(generation&&!/^[a-z0-9-]{1,40}$/.test(generation))throw Error('Invalid generation');
const suffix=generation?'.stable-'+generation+'.mjs':'.stable.mjs';
const proof=JSON.parse(await readFile(resolve(root,'../../../reports/self-recovery/offline-validation.json'),'utf8'));
if(!proof.passed)throw Error('Passing native recovery tests required');
for(const [name,expected]of Object.entries(proof.sourceSha256??{}))if(createHash('sha256').update(await readFile(resolve(root,name))).digest('hex')!==expected)throw Error('Acceptance source changed: '+name);
const manifest={observedAt:new Date().toISOString(),files:{}};
manifest.entry='standby'+suffix;
manifest.bootstrapEntry='bootstrap'+suffix;
for(const name of ['diagnostics','service-control','tool-protocol','kernel','standby','bootstrap']){
  let text=await readFile(resolve(root,name+'.mjs'),'utf8');
  for(const dep of ['diagnostics','service-control','tool-protocol','kernel','standby'])text=text.replaceAll("'./"+dep+".mjs'","'./"+dep+suffix+"'");
  if(name==='standby')text=text.replace("'kernel.mjs'","'kernel"+suffix+"'");
  const file=name+suffix;await writeFile(resolve(root,file),text,{flag:'wx'});
  manifest.files[file]=createHash('sha256').update(text).digest('hex');
}
if(generation){
 const previous=await readFile(resolve(root,'stable-manifest.json'));
 await writeFile(resolve(root,'stable-manifest.before-'+generation+'.json'),previous,{flag:'wx'});
 await writeFile(resolve(root,'stable-manifest.next.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
 if(!(await readFile(resolve(root,'stable-manifest.json'))).equals(previous))throw Error('Stable manifest changed concurrently');
 await rename(resolve(root,'stable-manifest.next.json'),resolve(root,'stable-manifest.json'));
}else await writeFile(resolve(root,'stable-manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({sealed:true,files:Object.keys(manifest.files)}));
