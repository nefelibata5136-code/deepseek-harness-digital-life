// Change only the outbound representation. Never execute or rewrite a tool action.
export function normalizeToolProtocol(messages) {
  const copy=messages.map(m=>({...m,content:Array.isArray(m.content)?m.content.map(b=>({...b})):m.content})),repairs=[];
  const results=new Map();
  for(const m of copy)for(const b of Array.isArray(m.content)?m.content:[])if(b.type==='tool_result') {
    if(results.has(b.tool_use_id))throw Error('DUPLICATE_TOOL_RESULT: '+b.tool_use_id);
    results.set(b.tool_use_id,{block:b,message:m});
  }
  for(let i=0;i<copy.length;i++) {
    const m=copy[i];if(m.role!=='assistant')continue;
    const calls=(Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_use');if(!calls.length)continue;
    // Some Messages endpoints reject a text tail after tool_use. Preserve all text,
    // thinking/signatures and call order, while putting calls after the text tail.
    if(m.content.slice(m.content.findIndex(b=>b.type==='tool_use')).some(b=>b.type!=='tool_use')) {
      m.content=[...m.content.filter(b=>b.type!=='tool_use'),...calls];
      repairs.push({kind:'assistant-tool-tail',callIds:calls.map(b=>b.id)});
    }
    let next=copy[i+1];
    const immediate=next?.role==='user'&&Array.isArray(next.content)&&calls.every(c=>next.content.some(b=>b.type==='tool_result'&&b.tool_use_id===c.id));
    if(immediate)continue;
    const blocks=[];
    for(const c of calls){
      const found=results.get(c.id);
      if(found){found.message.content=found.message.content.filter(b=>b!==found.block);blocks.push(found.block);}
      else blocks.push({type:'tool_result',tool_use_id:c.id,is_error:true,content:[{type:'text',text:'RECOVERY_OUTCOME_UNKNOWN: the durable result is absent. This is a protocol repair marker, not successful execution. Do not replay the action without checking its effects.'}]});
    }
    if(next?.role==='user')next.content=[...blocks,...(Array.isArray(next.content)?next.content:[{type:'text',text:next.content}])];
    else copy.splice(i+1,0,{role:'user',content:blocks});
    repairs.push({kind:'immediate-tool-results',callIds:calls.map(b=>b.id),unknownCallIds:calls.filter(c=>!results.has(c.id)).map(c=>c.id)});
  }
  const output=copy.filter(m=>m.content.length);
  assertToolProtocol(output);
  return {messages:output,repairs};
}
export function assertToolProtocol(messages) {
  for(let i=0;i<messages.length;i++) {
    const m=messages[i],calls=(Array.isArray(m.content)?m.content:[]).filter(b=>b.type==='tool_use');
    if(!calls.length)continue;
    const next=messages[i+1];
    if(next?.role!=='user'||!Array.isArray(next.content)||!calls.every(c=>next.content.some(b=>b.type==='tool_result'&&b.tool_use_id===c.id)))throw Error('TOOL_PAIR_NOT_IMMEDIATE');
  }
}
export function protocolMetadata(messages) {
  return messages.slice(-8).map((m,i)=>({index:messages.length-8+i,role:m.role,
    blocks:(Array.isArray(m.content)?m.content:[{type:'text'}]).map(b=>({type:b.type,...b.id?{id:b.id}:{},...b.tool_use_id?{toolUseId:b.tool_use_id}:{}}))}));
}
