import {acquireSlot} from './slots.mjs';
const lease=await acquireSlot(process.argv[2],2,AbortSignal.timeout(15000));
process.send({kind:'acquired',at:Date.now(),pid:process.pid});
if(process.argv[3]==='crash')process.exit(9);
await new Promise(resolve=>setTimeout(resolve,180));
const end=Date.now();await lease.release();process.send({kind:'released',at:end,pid:process.pid});
process.disconnect();
