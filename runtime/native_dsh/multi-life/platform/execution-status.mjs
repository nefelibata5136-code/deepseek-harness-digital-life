// Authenticated handlers call these synchronous projections. No tool, provider,
// credential resolution, budget, recovery or filesystem operation belongs here.
export function legacyExecutionStatus({ctx,sessionId,pid=process.pid,busy=0}) {
  const activeSessionIds=ctx.personaTasks?.running()??[];
  return {ready:Boolean(ctx.personaTasks),pid,sessionId,busy:busy>0||activeSessionIds.length>0,activeSessionIds};
}
export function lifeExecutionStatus({sessions,lifeId,pid=process.pid}) {
  return {ready:true,pid,life_id:lifeId,sessions:[...sessions].map(([id,row])=>({session_id:id,busy:row.agent.status==='running'}))};
}
