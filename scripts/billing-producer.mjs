// Explicit optional producer; no model calls. Reads only configured Host secrets.
import {Context} from '../runtime/native_dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import {startProducer} from '../runtime/deepseek_billing/service/producer.mjs';
const ctx=new Context(),state=await startProducer(ctx);
if(!state.active){console.log(JSON.stringify({active:false,reason:state.reason}));process.exit(0);}
console.log(JSON.stringify({active:true,source:'deepseek_platform',interval_ms:state.interval_ms}));
const keepAlive=setInterval(()=>{},60000);
const stop=async()=>{clearInterval(keepAlive);await state.stop();process.exit(0);};
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
