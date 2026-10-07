import {defineTool} from '@deepseek-ai/dsh-tools';
import {fail} from '../contracts.mjs';
const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
const hash={oneOf:[{type:'string'},{type:'null'}],description:'最近read返回的SHA256；创建不存在的文档时传null。'};
// One shared tool implementation, dispatched by a fresh trusted native execution.
export function mountLifeServiceTools(ctx,{services,execution}) {
  if(typeof execution!=='function'||!services)fail('LIFE_SERVICE_MOUNT_REQUIRES_TRUSTED_EXECUTION');
  const names=[];
  const register=(name,description,parameters,run)=>{
    names.push(name);ctx.tools.register(defineTool({name,description,parameters,output,
      execute:(args,exec)=>run(args,execution(exec),exec)}));
  };
  register('life_status','读取自己主体的状态、Resident设置和本人时钟；不读取心境正文。',{},(_a,c)=>services.status(c));
  register('life_mental_read','读取本人主动写下的未过期心境，不代作心理推断。',{},(_a,c)=>services.readMental(c));
  register('life_mental_write','本人写心境或以空文本清除；仅自我权威上下文可写。',{text:{type:'string',required:true},expiresAt:{type:'string'}},(a,c)=>services.writeMental(c,a));
  register('life_configure','本人管理Resident开关、间隔和自写原则。默认关闭；无需永久任务，恢复设置用原参数再次调用。',
    {residentEnabled:{type:'boolean'},intervalMs:{type:'integer'},directive:{type:'string'}},(a,c)=>services.configure(c,a));
  register('life_core_read','完整读取自己Core原文和当前hash；不读其他主体。',{},(_a,c)=>services.documents.read(c,'core'));
  register('life_core_write','本人修改自己Core，保留当前字节版本并校验hash。公共Runtime需另走发布入口。',
    {text:{type:'string',required:true},expectedHash:{...hash,required:true}},(a,c,exec)=>services.documents.write(c,{...a,kind:'core',signal:exec.signal}));
  register('life_working_read','完整读取自己接续条原文和hash。',{},(_a,c)=>services.documents.read(c,'continuity'));
  register('life_working_write','本人更新短接续条（最多8000 UTF-8 bytes），保留当前字节版本并校验hash。',
    {text:{type:'string',required:true},expectedHash:{...hash,required:true}},(a,c,exec)=>services.documents.write(c,{...a,kind:'continuity',signal:exec.signal}));
  register('life_document_restore','恢复本人Core/接续条的某个版本之前的字节，默认只预览；目标后来变化则拒绝。其他文件不变。',
    {versionId:{type:'string',required:true},expectedHash:{...hash,required:true},apply:{type:'boolean'}},(a,c,exec)=>services.documents.restore(c,{...a,signal:exec.signal}));
  register('life_pending_list','分页完整读自己主体的待接续原文；unknown owner会明确抑制而非共享。',
    {offset:{type:'integer'},limit:{type:'integer'},includeResolved:{type:'boolean'}},(a,c)=>services.listPending(c,a));
  register('life_pending_resolve','本人接受、拒绝或延后自己待接续建议；不会自动写长期记忆。',
    {id:{type:'string',required:true},decision:{type:'string',enum:['accepted','rejected','deferred'],required:true},note:{type:'string'}},(a,c)=>services.resolvePending(c,a));
  register('life_attention','只读聚合当前本人会话、待接续、已有schedule、本人运行活动和接续条；可以不处理。',{},(_a,c,exec)=>services.attention(c,exec.agent));
  register('life_rest','本人安静结束当前原生turn；可带原因给未来自己安排一次唤醒。不同主体不相互停止。',
    {nextWakeAt:{type:'string'},reason:{type:'string'}},async(a,c,exec)=>{const result=await services.rest(c,{...a,signal:exec.signal});exec.concludeTurn();return result;});
  // Names are explicit to avoid double-mounting current single-life Schedule tools.
  register('life_schedule_create','复用原生Schedule，在当前本人Session创建未来提醒；不能指定别的life/session。',
    {title:{type:'string'},prompt:{type:'string',required:true},at:{type:'string'},after_seconds:{type:'number'},every_seconds:{type:'number'}},(a,c,exec)=>services.schedule.create(c,a,exec.signal));
  register('life_schedule_list','读当前本人Session的原生未来提醒。',{},(_a,c)=>services.schedule.list(c));
  register('life_schedule_update','更新当前本人Session提醒；expected为最近list返回的完整原生record，保留原生CAS。',
    {id:{type:'string',required:true},expected:{type:'json',required:true},change:{type:'json'},title:{type:'string'},prompt:{type:'string'}},(a,c,exec)=>services.schedule.update(c,a,exec.signal));
  register('life_schedule_delete','删除当前本人Session的指定提醒；不会删除其他主体提醒。',
    {id:{type:'string',required:true}},(a,c,exec)=>services.schedule.delete(c,a,exec.signal));
  return {toolNames:Object.freeze(names),services};
}
