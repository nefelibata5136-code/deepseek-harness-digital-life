// Native skill discovery/body acceptance for the restricted-terminal simulation.
// No Agent, model, Host reload or workspace write.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { native, here } from '../workspace_foundation/native.mjs';
import { mountNativeFiles } from '../workspace_foundation/files.mjs';
import { mountWorkspaceSkills } from '../workspace_foundation/skills.mjs';
const base=resolve(here,'../..');
const evidence=JSON.parse(await readFile(resolve(base,'reports/self-maintenance/terminal-validation.json'),'utf8'));
const fixture=evidence.results.at(-1).result.steps.find(s=>s.capability==='skills').providerFixtures;
const results=[];
for(const [phase,workspace] of Object.entries(fixture)){
  const {Context}=await native('cordis');const ctx=new Context();
  try {
    for(const name of ['dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools'])await ctx.plugin((await native(name)).default);
    await mountNativeFiles(ctx,{workspace});await mountWorkspaceSkills(ctx,{workspace});
    const list=await ctx.skills.list({cwd:workspace});assert(list.some(s=>s.name==='self-maintenance-probe'));
    const skill=await ctx.skills.get('self-maintenance-probe',{cwd:workspace});
    const expected=phase==='changed'?'Hello from self-maintenance fixture':'Hello from Persona skill';
    assert(skill.content.includes(expected));results.push({phase,found:true,expectedBodyRead:true});
  }finally{await ctx.fiber.dispose();}
}
// Also verify the new maintenance Skill is actually discovered in the real
// workspace using the same official provider, not merely present on disk.
const workspace='.local/workspace';const {Context}=await native('cordis');const ctx=new Context();
try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools'])await ctx.plugin((await native(name)).default);
  await mountNativeFiles(ctx,{workspace});await mountWorkspaceSkills(ctx,{workspace});
  const list=await ctx.skills.list({cwd:workspace});assert(list.some(s=>s.name==='persona-self-maintenance'));
  assert((await ctx.skills.get('persona-self-maintenance',{cwd:workspace})).content.includes('change.mjs'));
}finally{await ctx.fiber.dispose();}
const result={passed:true,modelCalls:0,actualNativeProvider:true,newSkillDiscovered:true,results};
await writeFile(resolve(base,'reports/self-maintenance/skills-validation.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));
