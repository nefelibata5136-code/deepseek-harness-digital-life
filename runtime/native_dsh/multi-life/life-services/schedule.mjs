import {fail} from '../contracts.mjs';

// Called by the trusted native Schedule delivery resolver, never a model tool.
export function guardScheduleDeliveryTarget(registry,sessionId) {
  const owner=registry.owner(sessionId),manifest=registry.life(owner.lifeId);
  if(owner.status!=='ready')fail('SCHEDULE_TARGET_NOT_READY');
  return {lifeId:owner.lifeId,sessionId:owner.sessionId,role:owner.role,manifest};
}
export function createOwnerSchedule({contexts,schedule}) {
  const target=(context,sessionId)=>{const c=contexts.require(context);return contexts.target(c,sessionId??c.sessionId);};
  const available=()=>{if(!schedule)fail('NATIVE_SCHEDULE_NOT_MOUNTED');return schedule;};
  return {
    async create(context,request,signal) {
      const c=contexts.require(context);target(c);
      if(Object.hasOwn(request,'sessionId')||Object.hasOwn(request,'lifeId'))fail('SCHEDULE_OWNER_FIELDS_NOT_ACCEPTED');
      return {...await available().create(c.sessionId,request,signal),lifeId:c.lifeId,sessionId:c.sessionId};
    },
    async list(context,{sessionId}={}) {
      const c=contexts.require(context),owner=target(c,sessionId);
      const rows=await available().list({sessionId:owner.sessionId});contexts.require(c);
      return rows.map(row=>({...row,lifeId:c.lifeId,sessionId:owner.sessionId}));
    },
    async update(context,{id,expected,change,title,prompt,sessionId},signal) {
      const c=contexts.require(context),owner=target(c,sessionId);
      const {lifeId:_life,sessionId:_session,...record}=expected??{};
      return available().update({id,expected:record,change,...(title===undefined?{}:{title}),...(prompt===undefined?{}:{prompt}),sessionId:owner.sessionId},signal);
    },
    async delete(context,{id,sessionId},signal) {
      const c=contexts.require(context),owner=target(c,sessionId);
      return available().delete({id,sessionId:owner.sessionId},signal);
    },
  };
}
