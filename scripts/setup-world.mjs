import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,sep} from 'node:path';
import {randomUUID,randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {configure,root,data} from './configure.mjs';
export const worldRoot=resolve(process.env.DL_WORLD_ROOT||resolve(data,'world'));
export async function setupWorld(){
  await configure();await mkdir(worldRoot,{recursive:true});
  const settingsPath=resolve(worldRoot,'settings.json');
  try{return JSON.parse(await readFile(settingsPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  const template=JSON.parse(await readFile(resolve(root,'config/world.example.json'),'utf8'));
  if(!Array.isArray(template.lives)||template.lives.length<1)throw Error('EXPLICIT_LIFE_SLOTS_REQUIRED');
  const slots=new Set();
  const lives=[];
  for(const item of template.lives){
    if(!/^[A-Z][A-Z0-9_]{0,15}$/.test(item.slot)||slots.has(item.slot))throw Error('UNIQUE_LIFE_SLOT_REQUIRED');
    slots.add(item.slot);
    const lifeId='life-'+randomUUID(),base=resolve(data,'lives',item.slot),workspace=resolve(base,'workspace');
    for(const name of ['workspace','state','memory','vault','recovery','capabilities','attachments','versions','workspace/.dsh/skills'])await mkdir(resolve(base,name),{recursive:true});
    try{await access(resolve(workspace,'AGENTS.md'));}catch{await writeFile(resolve(workspace,'AGENTS.md'),'# Local digital life workspace\n\nWrite your own core.md before enabling this life. Source: '+root.split(sep).join('/')+'/runtime. Private notes and memory belong here. Shared Host code changes require reviewed release.\n',{flag:'wx'});}
    lives.push({...item,lifeId,authoritySessionId:randomUUID(),humanRoomId:randomUUID(),keyEnv:'DL_DEEPSEEK_KEY_'+item.slot,workspace,core:resolve(workspace,'core.md'),base});
  }
  const settings={...template,lives,worldRoot,peerRoomId:randomUUID(),python:process.env.DL_PYTHON||'python',tokens:{human:randomBytes(32).toString('hex'),operator:randomBytes(32).toString('hex'),workers:Object.fromEntries(lives.map(l=>[l.lifeId,randomBytes(32).toString('hex')]))}};
  await writeFile(settingsPath,JSON.stringify(settings,null,2)+'\n',{flag:'wx',mode:0o600});
  return settings;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){const settings=await setupWorld();console.log(JSON.stringify({configured:true,lives:settings.lives.map(l=>({slot:l.slot,core:l.core,key_environment:l.keyEnv})),modelRequests:0}));}
