import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {existsSync} from 'node:fs';
export const root = fileURLToPath(new URL('../', import.meta.url));
const localPython=resolve(root,process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
if(!process.env.DL_PYTHON&&existsSync(localPython))process.env.DL_PYTHON=localPython;
export const data = resolve(root, '.local');
export const workspace = resolve(data, 'workspace');
export async function configure() {
  const python = process.env.DL_PYTHON || 'python';
  const profile = resolve(root, 'runtime/native_dsh/home/profiles/persona');
  for (const dir of [profile, workspace, resolve(data,'history'), resolve(data,'legacy'), resolve(data,'advisors'), resolve(workspace,'memory'), resolve(workspace,'.dsh/skills')]) await mkdir(dir,{recursive:true});
  const replace = value => typeof value === 'string' ? value.replaceAll('@PYTHON@', python)
    .replaceAll('@MODULE_RESIDENT@', pathToFileURL(resolve(root,'runtime/native_dsh/digital-life/resident.mjs')).href)
    .replaceAll('@ROOT@', root.split(sep).join('/').replace(/\/$/,''))
    .replaceAll('@DATA@', data.split(sep).join('/')).replaceAll('@WORKSPACE@', workspace.split(sep).join('/'))
    : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)])) : value;
  const config=replace(JSON.parse(await readFile(resolve(root,'config/cordis.patch.example.json'),'utf8')));
  // Public default keeps desktop and browser disabled and secondary authority narrow.
  await writeFile(resolve(profile,'cordis.patch.yml'),JSON.stringify(config,null,2)+'\n');
  await writeFile(resolve(profile,'cordis.yml'),'[]\n');
  await writeFile(resolve(profile,'package.json'),await readFile(resolve(root,'config/profile.package.example.json')));
  await writeFile(resolve(root,'runtime/native_dsh/host-cordis.yml'),'[]\n');
  // Refuse to invent the persona's identity or continuity. Only a navigational map.
  try {await access(resolve(workspace,'AGENTS.md'));} catch {await writeFile(resolve(workspace,'AGENTS.md'),'# Local persona workspace\n\nIdentity: persona-core.md. Write your own identity before starting.\nNotes and memory are private. Source: ../../runtime.\n');}
  let settings;
  try {settings=JSON.parse(await readFile(resolve(data,'runtime.json'),'utf8'));}
  catch (e) {if(e.code!=='ENOENT')throw e; settings={sessionId:randomUUID(),workspace,data,python};await writeFile(resolve(data,'runtime.json'),JSON.stringify(settings,null,2)+'\n',{flag:'wx',mode:0o600});}
  return settings;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){await configure();console.log('Configured local-only runtime. Write .local/workspace/persona-core.md before npm start.');}
