import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {native} from '../workspace_foundation/native.mjs';
import {mountNativeFiles} from '../workspace_foundation/files.mjs';
import {mountWorkspaceSkills} from '../workspace_foundation/skills.mjs';
const workspace='.local/workspace';const {Context}=await native('cordis');const ctx=new Context();
try{
  for(const name of ['dsh-session','dsh-session-projection','dsh-system-prompt','dsh-tools'])await ctx.plugin((await native(name)).default);
  await mountNativeFiles(ctx,{workspace,fullAccess:true});await mountWorkspaceSkills(ctx,{workspace});
  const list=await ctx.skills.list({cwd:workspace});const found=list.find(s=>s.name==='persona-activity-progress');assert(found);
  const skill=await ctx.skills.get('persona-activity-progress',{cwd:workspace});assert(skill.content.includes('maintain.mjs'));assert(skill.content.includes('不为使用该格式另调用 skill'));
  const result={passed:true,actualNativeProvider:true,modelCalls:0,newSkillDiscovered:true,bodyVerified:true,description:found.description};
  await writeFile(new URL('../../reports/activity_progress/skill-validation.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await ctx.fiber.dispose();}
