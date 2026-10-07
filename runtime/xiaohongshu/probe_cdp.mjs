// Bounded metadata-only Chrome diagnosis. No navigation, account writes or cookies.
const v=await (await fetch('http://127.0.0.1:18745/json/version')).json();
const ws=new WebSocket(v.webSocketDebuggerUrl);let id=0;const pending=new Map();
ws.addEventListener('message',e=>{const r=JSON.parse(e.data);const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);p.resolve(r);}});
await new Promise((ok,no)=>{ws.addEventListener('open',ok,{once:true});ws.addEventListener('error',no,{once:true});});
function call(method,params={},sessionId){return new Promise(resolve=>{const n=++id;pending.set(n,{resolve,timer:setTimeout(()=>{pending.delete(n);resolve({timeout:true});},2000)});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});}
try{
  const targets=(await call('Target.getTargets')).result.targetInfos.filter(t=>t.type==='page');
  for(const target of targets){
    const sid=(await call('Target.attachToTarget',{targetId:target.targetId,flatten:true})).result?.sessionId;
    if(!sid)continue;
    const resumed=await call('Runtime.runIfWaitingForDebugger',{},sid);
    const name=await call('Runtime.evaluate',{expression:'window.name',returnByValue:true},sid);
    const tree=await call('Page.getFrameTree',{},sid);
    console.log(JSON.stringify({targetId:target.targetId,title:target.title,subtype:target.subtype,role:name.result?.result?.value,frameTree:!!tree.result,timeout:!!tree.timeout,resumed:!!resumed.result}));
    await call('Target.detachFromTarget',{sessionId:sid});
  }
}finally{ws.close();}
