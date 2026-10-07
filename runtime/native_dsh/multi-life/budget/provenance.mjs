// Trusted Host/native provenance only. Never classify by model-written text.
import {randomUUID,createHash} from 'node:crypto';
export const COST_REASONS=Object.freeze(['human_room','peer_room','scheduler','resident','subagent','developer_test','other']);
const roomKinds=new Set(['life-message','room-inbox','room-inbox-batch']);
function reasonFor(source,role,requestId) {
  if(role==='delegate'||source?.kind==='delegated-task')return 'subagent';
  if(['developer-test','host-notice','development-test'].includes(source?.kind)||source?.reasonKind==='developer-test'||source?.reason==='developer_test')return 'developer_test';
  if(String(requestId).startsWith('resident:')||source?.kind==='resident')return 'resident';
  if(['schedule','scheduled','scheduler'].includes(source?.kind))return 'scheduler';
  if(roomKinds.has(source?.kind)) {
    const types=source.sender_types??(source.senders?.map(sender=>sender.sender_type))??[source.sender?.sender_type];
    if(types.length&&types.every(type=>type==='human'))return 'human_room';
    if(types.length&&types.every(type=>type==='life'))return 'peer_room';
  }
  // Only an explicitly Host-authenticated human principal proves human origin.
  if(source?.sender?.sender_type==='human'&&source?.sender?.sender_id?.startsWith('human:'))return 'human_room';
  return 'other';
}
export function provenanceForAgent(agent,{lifeId=null,role='activity',runId,requestId,reason}={}) {
  const events=agent.session.ownEvents?[...agent.session.ownEvents()]:[];
  const start=events.findLast(event=>event.type==='turn/start');
  const source=events.findLast(event=>event.type==='user/message'&&event.data.source?.rpcId)?.data.source;
  const request=requestId??source?.rpcId??null;
  return Object.freeze({life_id:lifeId,run_id:runId??(start?agent.session.id+':turn:'+start.data.turn:randomUUID()),
    request_id:request,reason:reason??reasonFor(source,role,request),source_kind:source?.kind??null,
    origin_room_id:source?.roomId??source?.conversationId??null,
    provenance:source?'trusted_native_source':'trusted_owner_source_unknown'});
}
export function wirePromptMetadata(body) {
  // Fingerprints and sizes only; no prompt, tool descriptions, secrets, or
  // private content enters the usage ledger. This is observation, not a token
  // estimator or a claim about the Provider's exact cache-prefix algorithm.
  const hash=value=>createHash('sha256').update(JSON.stringify(value??null)).digest('hex');
  return {system_hash:hash(body.system),tools_hash:hash(body.tools),
    tool_order_hash:hash((body.tools??[]).map(tool=>tool.name)),first_message_hash:hash(body.messages?.[0]),
    system_bytes:Buffer.byteLength(JSON.stringify(body.system??null)),
    tools_bytes:Buffer.byteLength(JSON.stringify(body.tools??null)),message_count:body.messages?.length??0,
    reasoning_effort:['low','medium','high','off'].includes(body.output_config?.effort)?body.output_config.effort:null,
    thinking_mode:['enabled','disabled','adaptive'].includes(body.thinking?.type)?body.thinking.type:null};
}
