import {native} from '../../../workspace_foundation/native.mjs';
import {guardScheduleDeliveryTarget} from './schedule.mjs';
import {fail} from '../contracts.mjs';
import {findDeliveredMessage} from '../../../time_host/time-host.mjs';

// One official durable Schedule implementation; owner resolution is supplied by
// the shared trusted runtime. This mount never selects a singleton current life.
export async function mountLifeNativeSchedule(ctx,{contexts,runtime,root,admit}) {
  const plugin=async name=>{const module=await native(name);return module.default??module;};
  if(!contexts||!runtime||typeof admit!=='function'||!root)fail('NATIVE_SCHEDULE_TRUSTED_MOUNT_REQUIRED');
  contexts.registry.addControlRoot(root);
  if(!ctx.get('sessionPersistence'))fail('NATIVE_SCHEDULE_PERSISTENCE_REQUIRED');
  // In a formal boot these three shared services should already be kernel rows:
  // dsh-storage {}, dsh-storage-json {root}, dsh-storage-domain {backend:'json'}.
  if(!ctx.get('storage'))await ctx.plugin(await plugin('dsh-storage'),{}).await();
  if(!ctx.get('storageDomain')) {
    await ctx.plugin(await plugin('dsh-storage-json'),{root}).await();
    await ctx.plugin(await plugin('dsh-storage-domain'),{backend:'json'}).await();
  }
  if(!ctx.get('typert'))await ctx.plugin(await plugin('dsh-typert-registry'),{}).await();
  const aliases=new Map(),storageDomain=ctx.get('storageDomain');
  const scoped=ctx.isolate('sessionController').isolate('schedule').isolate('storageDomain');
  await scoped.plugin({name:'multi-life-schedule-owner-resolver',apply(child) {
    child.provide('sessionController',{async resolveAgent(sessionId) {
      try {
        const target=guardScheduleDeliveryTarget(contexts.registry,sessionId);
        const agent=await runtime.resolve({lifeId:target.lifeId,sessionId});
        const context=contexts.execution(agent,{costCategory:'schedule'});contexts.require(context);
        if((await admit(context))?.allowed!==true)fail('SCHEDULE_ADMISSION_DENIED');
        contexts.require(context);
        if(agent.session.id!==sessionId)fail('SCHEDULE_RESOLVED_WRONG_OWNER');
        return {agent:{session:agent.session,followup(message) {
          contexts.require(context);
          const existing=findDeliveredMessage(agent.session,message);
          if(existing){aliases.set(message.id,existing.id);return;}
          return agent.followup(message);
        }}};
      }catch(error){return {error};}
    }});
    // Preserve time_host's crash window receipt semantics without replacing the
    // official scheduler: its already-durable inbox message keeps the same id.
    child.provide('storageDomain',{async open(spec) {
      const domain=await storageDomain.open(spec),tasks=domain.table('tasks');
      const wrapped=new Proxy(tasks,{get(target,key) {
        if(key==='put')return (id,task)=>{
          const alias=aliases.get(task.lastDelivery?.messageId);
          if(alias)task={...task,lastDelivery:{...task.lastDelivery,messageId:alias},deliveryHistory:{...task.deliveryHistory,
            records:task.deliveryHistory.records.map(row=>aliases.has(row.messageId)?{...row,messageId:aliases.get(row.messageId)}:row)}};
          return target.put(id,task);
        };
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      return new Proxy(domain,{get(target,key) {
        if(key==='table')return name=>name==='tasks'?wrapped:target.table(name);
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    }});
  }}).await();
  const Schedule=(await native('dsh-schedule')).default;
  await scoped.plugin(Schedule,{deliveryHistoryDays:30,deliveryHistoryRecords:200}).await();
  const schedule=scoped.get('schedule');if(!schedule)fail('NATIVE_SCHEDULE_DID_NOT_MOUNT');
  return schedule;
}
