import {freeze,fail} from './contracts.mjs';
import {provenanceForAgent} from './budget/provenance.mjs';
// Object identity is the authority. Tool JSON and ambient initiator are not.
export class LifeContexts {
  #agents=new WeakMap(); #executions=new WeakMap();
  constructor(registry){this.registry=registry;}
  bind(agent) {
    const row=this.registry.assertNative(agent.session.id,agent.session.header);
    const manifest=this.registry.life(row.lifeId);
    const bound=freeze({lifeId:row.lifeId,sessionId:row.sessionId,role:row.role,parentSessionId:row.parentSessionId,manifestRevision:manifest.revision,reservationId:row.reservationId,manifest});
    this.#agents.set(agent,bound);return bound;
  }
  forAgent(agent) {
    const bound=this.#agents.get(agent);if(!bound)fail('TRUSTED_AGENT_CONTEXT_REQUIRED');
    const owner=this.registry.assertNative(bound.sessionId,agent.session.header);
    if(owner.lifeId!==bound.lifeId||owner.reservationId!==bound.reservationId)fail('STALE_OWNER_BINDING');
    if(this.registry.life(bound.lifeId).revision!==bound.manifestRevision)fail('STALE_MANIFEST_BINDING');
    if(this.presetOf&&this.presetOf(agent)!==bound.manifest.deployment.presetId)fail('ACTIVE_PRESET_OWNER_MISMATCH');
    return bound;
  }
  execution(agent,options={}) {
    if(this.isLive&&!this.isLive(agent))fail('LIFE_AGENT_NOT_LIVE');
    const bound=this.forAgent(agent),provenance=provenanceForAgent(agent,{lifeId:bound.lifeId,role:bound.role,
      runId:options.runId,requestId:options.requestId,reason:options.costCategory});
    const {runId=provenance.run_id,requestId=provenance.request_id,callId=null,costCategory=provenance.reason}=options;
    const task=this.tasks?.forSession(bound.sessionId);
    const value=freeze({...bound,runId,requestId,callId,costCategory,sourceKind:provenance.source_kind,costProvenance:provenance.provenance,
      owner_life_id:bound.lifeId,task_id:task?.task_id??null,parent_task_id:task?.parent_task_id??null,origin_room_id:provenance.origin_room_id??task?.origin_room_id??null});this.#executions.set(value,agent);return value;
  }
  require(context) {
    if(!this.#executions.has(context))fail('TRUSTED_EXECUTION_CONTEXT_REQUIRED');
    const agent=this.#executions.get(context);
    if(this.isLive&&!this.isLive(agent))fail('LIFE_AGENT_NOT_LIVE');
    this.forAgent(agent);
    const row=this.registry.owner(context.sessionId);
    if(row.lifeId!==context.lifeId||row.reservationId!==context.reservationId||this.registry.life(row.lifeId).revision!==context.manifestRevision)fail('STALE_EXECUTION_CONTEXT');
    return context;
  }
  requireAuthority(context){const c=this.require(context);if(c.role!=='authority')fail('AUTHORITY_REQUIRED');return c;}
  target(context,sessionId){return this.registry.assertTarget(this.require(context).lifeId,sessionId);}
}
