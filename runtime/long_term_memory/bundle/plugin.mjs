import {spawn} from 'node:child_process';
export const inject=['tools','credentials'];
const python=(process.env.DL_PYTHON || 'python');
const cli='./runtime/long_term_memory/cli.py';
const str={type:'string'},integer={type:'integer'},bool={type:'boolean'},strings={type:'array',items:str};
export function apply(ctx){
  async function run(operation,args,exec){
    const env={PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
    for(const k of ['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[k])env[k]=process.env[k];
    if(operation==='search'){
      const credential=await ctx.credentials.resolve('DL_QWEN_API_KEY');
      if(!credential?.value)return {ok:false,error:'QWEN_CREDENTIAL_REFERENCE_UNAVAILABLE'};
      env.DASHSCOPE_API_KEY=credential.value;
    }
    return new Promise(resolve=>{
      const child=spawn(python,['-X','utf8',cli,'bridge'],{env,windowsHide:true,stdio:['pipe','pipe','ignore']});
      let output='',settled=false;
      const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);exec.signal?.removeEventListener('abort',cancel);resolve(value);};
      const cancel=()=>{child.kill();finish({ok:false,error:'MEMORY_OPERATION_CANCELLED; inspect status before retrying a write'});};
      const timer=setTimeout(()=>{child.kill();finish({ok:false,error:'MEMORY_OPERATION_TIMEOUT; inspect status before retrying'});},26000);
      exec.signal?.addEventListener('abort',cancel,{once:true});
      child.stdout.setEncoding('utf8');child.stdout.on('data',s=>{output+=s;if(Buffer.byteLength(output)>1000000){child.kill();finish({ok:false,error:'MEMORY_OUTPUT_LIMIT; use explicit pages'});}});
      child.on('error',()=>finish({ok:false,error:'MEMORY_PROCESS_UNAVAILABLE'}));
      child.on('close',()=>{try{finish(JSON.parse(output));}catch{finish({ok:false,error:'MEMORY_RESPONSE_UNAVAILABLE; inspect status before retrying a write'});}});
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({operation,arguments:args,native_call_id:exec.callId}));
    });
  }
  function add(name,description,properties={},required=[],transform=a=>a){
    ctx.tools.register({name:'memory_'+name,description,parameters:{type:'object',properties,required,additionalProperties:false},
      output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
      execute:(args,exec)=>run(name,transform(args),exec)});
  }
  add('search','千问 Embedding 召回并 Rerank，仅返回人格正式接受的记忆入口。原文主动 open；分数不是事实解释。search_id 可查全部候选。',
    {query:str,limit:integer,candidates:integer,include_test:bool,tags:strings,speaker:str,from_time:str,to_time:str},['query']);
  add('open','按需分页读摘要、局部、事件原文、单条消息、关联、判断版本或并列来源。offset 是 Unicode 字符。search_audit 读完整候选分数。',
    {event_id:str,view:{type:'string',enum:['summary','local','event','message','relations','versions','source_compare','source_conflicts','search_audit']},memory_id:str,record_id:str,namespace:str,conversation:str,offset:integer,limit:integer,include_test:bool,version:str,search_id:str},['view']);
  add('catalog','可读事件目录；待复核和拒绝的决定保留。自由标签过滤，关联线不是事件。',{offset:integer,limit:integer,tags:strings,status:str});
  add('pending','未整理原始消息分页列表，不是机械事件边界。可按 namespace/conversation 浏览，随后 open(message) 阅读。',{offset:integer,limit:integer,namespace:str,conversation:str});
  add('status','计数、来源变化和 API 请求审计概况；费用使用量不是供应商实扣证明。');
  add('sync','只登记真实原文增量/修改/删除观察，不自动建事件或接受记忆。');
  add('propose','提交语义事件候选（JSON）；source_refs 与入口 refs 必须准确映射原文。子 Agent 只能建议，不能署名为人格。',
    {event_json:str,event_id:str,expected_revision:integer},['event_json'],a=>{const {event_json,...rest}=a;return {...rest,event:JSON.parse(event_json)};});
  add('accept','顶层人格明确接受/拒绝/撤回事件，留追加决定；使用 catalog 当前 revision。',
    {event_id:str,status:{type:'string',enum:['accepted','candidate','withdrawn','rejected']},expected_revision:integer},['event_id','expected_revision']);
  add('annotate','顶层人格追加自由标签、意义或备注；fields_json 可任意扩展。supersedes 指向旧批注，旧字保留。',
    {event_id:str,fields_json:str,expected_revision:integer,supersedes:str},['event_id','fields_json','expected_revision'],a=>{const {fields_json,...rest}=a;return {...rest,fields:JSON.parse(fields_json)};});
  add('link','顶层人格追加事件关联，relation 是她的自由表述。',{from_event:str,to_event:str,relation:str},['from_event','to_event','relation']);
}
