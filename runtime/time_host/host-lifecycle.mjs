/** A calls after its official Host, exact Session and D provider guard are ready. */
export function installHostLifecycle(ctx, { sessionId, budgetProtected }) {
  if (!sessionId || budgetProtected !== true) throw new Error('Host readiness requires A Session and D budget guard');
  let stopped = false;
  const stop = async () => {
    if (stopped) return; stopped = true;
    try { await ctx.fiber.dispose(); process.exit(0); }
    catch { process.exit(1); }
  };
  const message = event => { if (event?.type === 'persona-host-stop') void stop(); };
  process.on('message', message); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.once('disconnect', stop);
  process.send?.({ type: 'persona-host-ready', sessionId, budgetProtected: true });
  return stop;
}
