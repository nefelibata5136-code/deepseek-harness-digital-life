// End the temporary diagnostic launch through Electron's normal quit path.
const targets=await(await fetch('http://127.0.0.1:19452/json/list')).json();
const socket=new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((done,reject)=>{socket.addEventListener('open',done,{once:true});socket.addEventListener('error',reject,{once:true});});
const closed=new Promise(done=>socket.addEventListener('close',done,{once:true}));
socket.addEventListener('message',event=>{if(JSON.parse(event.data).id===1)socket.close();});
socket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:"process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.quit()",returnByValue:true}}));
await closed;
console.log('Diagnostic launch ended through normal application quit.');
