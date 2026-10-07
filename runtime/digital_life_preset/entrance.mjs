/** A preset-scoped entrance that forwards user input and refuses a local model turn. */
import {createHash} from 'node:crypto';

/** Derive the same UUID after a replay; distinct native messages keep distinct IDs. */
export function forwardingId(agent, messages) {
  if (messages.length === 1 && /^[a-f0-9-]{36}$/i.test(messages[0].source?.rpcId ?? ''))
    return messages[0].source.rpcId;
  if (messages.some(message => typeof message.id !== 'string' || !message.id))
    throw new Error('Persona entrance requires a durable native message identity');
  const hex = createHash('sha256').update(JSON.stringify([String(agent.id), messages.map(message => message.id)])).digest('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

/** Build a handler with injectable transport for keyless verification. */
export function createEntrance({hostRequest, identity,receiptFor=()=>null}) {
  return async ({agent, messages,turn,signal}, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    // Use the original claim; downstream assembly may add system-owned context.
    const users = messages.filter(message => message.role === 'user' && message.source?.kind === 'user');
    if (!users.length) return {kind:'reject'};
    if (users.some(message => message.content.some(block => block.type !== 'text')))
      throw new Error('Persona attachments must be sent from her resident workspace; no content was forwarded');
    const text = users.flatMap(message => message.content.map(block => block.text)).join('\n');
    if (!text.trim()) return {kind:'reject'};
    const sessionId = await identity();
    const receipts=users.map(message=>receiptFor(agent,message));
    // Human events retain each original native identity and occurrence time.
    // Unproven messages in the same claim acquire no human identity.
    const groups=receipts.some(Boolean)?users.map((message,index)=>({messages:[message],receipt:receipts[index]})):
      [{messages:users,receipt:null}];
    // Protected Host deduplication checks the persisted native inbox before admitting input.
    // Never retry here: after a disconnect, native history determines whether it arrived.
    async function forward(group) {
      signal?.throwIfAborted();
      const body={sessionId,mode:'queue',text:group.messages.flatMap(message=>message.content.map(block=>block.text)).join('\n'),requestId:forwardingId(agent,group.messages)};
      if(!body.text.trim())return;
      if(group.receipt)Object.assign(body,{humanPrincipalId:group.receipt.humanPrincipalId,humanOccurredAt:group.receipt.occurredAt});
      const result = await hostRequest('POST', '/prompt',body);
      if (result.status !== 200 && result.status !== 409)
        throw new Error(`Persona resident Host refused input (${result.status}); inspect her workspace before retrying`);
    }
    for(const group of groups)await forward(group);
    // rc.2 stops a carrier driver after a rejected local step, even if another
    // real input queued while forwarding. Claim that durable user prefix now;
    // leave non-user items untouched and never introduce a synthetic wake.
    const inbox=agent.inbox,isUser=message=>message.role==='user'&&message.source?.kind==='user';
    if(typeof inbox?.claim==='function'&&Number.isSafeInteger(turn)) {
      while(true) {
        signal?.throwIfAborted();
        const nextStep=inbox.nextStep,nextTurn=inbox.nextTurn;
        if(!Array.isArray(nextStep)||!Array.isArray(nextTurn))break;
        const target=nextStep.length?nextStep.every(isUser)?'next-step':null:isUser(nextTurn[0]??{})?'next-turn':null;
        if(!target)break;
        const pending=target==='next-step'?[...nextStep]:[nextTurn[0]];
        if(pending.some(message=>message.content.some(block=>block.type!=='text')))
          throw new Error('Persona attachments must be sent from her resident workspace; queued attachment stays pending');
        const claimed=inbox.claim(target,turn);
        if(claimed.length!==pending.length||claimed.some((message,index)=>message.id!==pending[index].id))
          throw new Error('Persona native carrier claim changed; inspect durable inbox before retrying');
        let confirmed=0;
        try{for(const message of claimed){await forward({messages:[message],receipt:receiptFor(agent,message)});confirmed++;}}
        catch(error){
          // Retain unconfirmed exact native messages for inspection. Do not wake
          // or retry them here; the protected inbox decides any later replay.
          if(!signal?.aborted)for(const message of claimed.slice(confirmed).reverse())inbox.prepend(target,message);
          throw error;
        }
      }
    }
    return {kind:'reject'};
  };
}

/** Register the waterfall inside the Persona preset scope. */
export async function apply(ctx, config) {
  if (typeof config.adapter !== 'string' || !config.adapter.startsWith('file:///'))
    throw new Error('Persona resident entrance requires an explicit local transport adapter');
  const adapter = await import(config.adapter);
  if (typeof adapter.hostRequest !== 'function' || typeof adapter.identity !== 'function')
    throw new Error('Persona resident transport adapter has no protected Host entrance');
  ctx.on('agent/pre-step', createEntrance({...adapter,receiptFor:(agent,message)=>ctx.get('digitalLifeHumanInput')?.receiptFor(agent,message)??null}));
}
