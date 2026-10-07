import {readFileSync,existsSync} from 'node:fs';

// Temporary Host test control; does not overwrite a life's chosen strategy.
// The wire check fails closed if any later hook silently lowers the effort.
export function mountHighTestOverride(ctx,{path,lifeId}) {
  const mountedAt=Date.now();
  const read=()=>{
    if(!existsSync(path))return false;
    const config=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
    return config.enabled===true&&Array.isArray(config.life_ids)&&config.life_ids.includes(lifeId);
  };
  ctx.on('agent/request',async(request,next)=>{
    const config=await next();return read()?{...config,reasoningEffort:'high'}:config;
  },{prepend:true});
  let modelCalls=0,modelWakes=0;
  ctx.on('session/event',(_s,e)=>{if(e.type==='turn/start'&&new Date(e.time).getTime()>=mountedAt)modelWakes++;});
  ctx.on('llm/stream',async function*(options,next){
    if(read()&&options.reasoningEffort!=='high')throw Object.assign(new Error('TEST_HIGH_OVERRIDE_NOT_APPLIED'),{code:'TEST_HIGH_OVERRIDE_NOT_APPLIED'});
    modelCalls++;yield* next();
  },{prepend:true});
  return {status:()=>({model_calls:modelCalls,model_wakes:modelWakes,reasoning_override:read()?'high':null})};
}
