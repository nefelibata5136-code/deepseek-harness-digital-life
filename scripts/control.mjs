import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { data } from './configure.mjs';
const [action='status', ...words]=process.argv.slice(2);
if(!['status','tasks','prompt'].includes(action))throw new Error('Use status, tasks or prompt');
const {port,token,sessionId}=JSON.parse(await readFile(resolve(data,'host-state/.host-control.json'),'utf8'));
const response=await fetch('http://127.0.0.1:'+port+'/'+action,{
 method:action==='prompt'?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},
 ...(action==='prompt'?{body:JSON.stringify({sessionId,requestId:randomUUID(),text:words.join(' ')})}:{})});
if(!response.ok)throw new Error('Host returned HTTP '+response.status);
const result=await response.json();console.log(JSON.stringify(result,null,2));
