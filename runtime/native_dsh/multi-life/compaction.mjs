// Reuse the same author's native Session/surface machinery. No auxiliary model.
import {apply as install,inject as dependencies} from '../persona-compaction.mjs';
export const inject=[...dependencies,'multiLifeContexts'];
export const authorPressure={triggerRatio:0.70,authorMaxTokens:8192,marginTokens:8192,maxAuthorSteps:32,viewBytes:180000};
export async function apply(ctx,config={}) {
  if(config.mode==='legacy')throw new Error('OWNER_SELF_COMPACTION_AUTHOR_REQUIRED');
  await install(ctx,{...config,mode:'self-authored',policy:{auto:false,retainRatio:0.16,headroomTokens:65536},
    authorPressure:{...authorPressure,...config.authorPressure}});
  // Binding is derived from the live Agent, never from a life/session tool argument.
  ctx.on('tools/execute',async(exec,next)=>{
    if(exec.name==='context_compact'||exec.name.startsWith('context_compact_')) {
      const c=ctx.multiLifeContexts.execution(exec.agent,{callId:exec.callId});
      ctx.multiLifeContexts.require(c);
    }
    return next();
  },{prepend:true});
}
export default {apply,inject};
