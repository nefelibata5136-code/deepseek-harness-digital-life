// The native controller owns same-turn delivery and request deduplication.
// Do not hold the turn admission lease or wait for idle for a steering receipt.
export async function admitSteering(ctx,input){
 const mode=input.mode??'steer';
 if(!['steer','queue'].includes(mode))throw Error('Invalid prompt mode');
 const resolved=await ctx.sessionController.resolveAgent(input.sessionId);
 if('error' in resolved)throw resolved.error;
 await ctx.sessionController.prompt({sessionId:input.sessionId,requestId:input.requestId,mode,
  clientTimeZone:'Asia/Shanghai',content:[{type:'text',text:input.text}]},new AbortController().signal);
 await ctx.sessions.flush(resolved.agent.session);
 return {state:'accepted',mode,sessionId:input.sessionId,requestId:input.requestId};
}
