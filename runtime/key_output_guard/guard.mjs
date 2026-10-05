import {createDetector, credentialAccessCandidate, BLOCKED} from './detector.mjs';

export function createKeyOutputGuard({knownSecrets = []} = {}) {
  const detector = createDetector(knownSecrets);
  const counts = {blockedToolInputs: 0, blockedToolOutputs: 0, blockedModelRequests: 0, sanitizedEvents: 0, credentialAccessCandidates: 0};
  const audit = [];
  const record = (kind, hit, exec = {}) => {
    counts[kind]++;
    audit.push({observedAt: new Date().toISOString(), kind, ...hit,
      ...(exec.name ? {tool: exec.name} : {}), ...(exec.agent ? {sessionId: String(exec.agent.session.id)} : {})});
    if (audit.length > 200) audit.shift();
  };
  const status = () => ({enabled: true, mode: 'text-output-screening', usesLocalModel: false, ...counts,
    securityBoundary: false, candidateSignalsAreNotIntentProof: true});
  const screenRequest = (input, init = {}) => {
    const hit = detector.inspect(init.body);
    if (hit) {record('blockedModelRequests', hit); throw new Error('KEY_OUTPUT_BLOCKED: request body contains possible key');}
  };
  const wrapTransport = transport => {
    const wrapped = async (input, init = {}) => {screenRequest(input, init); return transport(input, init);};
    wrapped.keyOutputPreflight = screenRequest;
    return wrapped;
  };
  const mount = ctx => {
    // Block the whole normalized outcome, including value/metadata/extra contexts.
    // Replacing only rendered text would leave alternate plaintext projections.
    ctx.on('tools/post-execute', async (exec, result, next) => {
      const hit = detector.inspect(result);
      if (hit) {record('blockedToolOutputs', hit, exec); return {kind: 'block', feedback: [{type: 'text', text: BLOCKED}]};}
      return next();
    });
    ctx.tools.guard(exec => {
      const hit = detector.inspect(exec.arguments);
      if (hit) {record('blockedToolInputs', hit, exec); return BLOCKED;}
      const candidate = credentialAccessCandidate(exec.name, exec.arguments);
      if (candidate) record('credentialAccessCandidates', candidate, exec);
      // Access candidates are observations only; ordinary file/process access stays unrestricted.
    });
    const installed = new WeakSet();
    const install = session => {
      if (installed.has(session)) return; installed.add(session);
      const append = session.append.bind(session);
      session.append = (type, data, ...opts) => {
        const hit = detector.inspect(data);
        if (hit) record('sanitizedEvents', hit);
        return append(type, hit ? detector.sanitize(data) : data, ...opts);
      };
    };
    ctx.on('session/created', install);
    for (const session of ctx.sessions.list()) install(session);
    ctx.provide('keyOutputGuard', {status, audit: () => audit.map(item => ({...item}))});
  };
  return {detector, wrapTransport, mount, status, audit: () => audit.map(item => ({...item}))};
}
