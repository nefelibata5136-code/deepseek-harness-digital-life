import Subagents from '@deepseek-ai/dsh-subagent';
import Subprocess from '@deepseek-ai/dsh-subprocess-local';
import {AgentRouter,loadSettings,registerRouterTools} from './router.mjs';

// Mounted only by a production LifeRuntime. Existing isolated fixtures keep
// their synthetic native delegates; live tests use real owner-bound Sessions.
export async function mountModernRouter(runtime) {
  const {ctx,contexts}=runtime;
  if(!ctx.get('subprocess'))await ctx.plugin(Subprocess,{});
  if(!ctx.get('subagents'))await ctx.plugin(Subagents,{maxActiveSubagents:8,maxDepth:1});
  const router=new AgentRouter(ctx,await loadSettings(),{ownerFor:parent=>contexts.forAgent(parent),
    deepseekStart:async(c,args)=>{
      if(args.model&&args.model!==c.manifest.deployment.model)throw new Error('DEEPSEEK_MODEL_OVERRIDE_NOT_PRICED');
      const value=await runtime.delegateDeepseek(contexts.execution(ctx.agents.get(c.sessionId)),{task:args.task??args.prompt});
      const {agent,...receipt}=value;
      return {...receipt,child_id:receipt.sessionId,provider:c.manifest.deployment.provider,model:c.manifest.deployment.model,fallback:false};
    }});
  registerRouterTools(ctx,router,{codexAlias:true,deepseekAlias:true});
  ctx.provide('lifeSubagentRouter',router);ctx.effect(()=>()=>router.dispose(),'owner-bound Luna router');
  runtime.subagentRouter=router;return router;
}
