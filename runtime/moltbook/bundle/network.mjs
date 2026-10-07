// Reuse the installed undici fetch/ProxyAgent pair used by existing Bluesky.
// The local proxy carries an HTTPS CONNECT tunnel, not the API bearer header.
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../native_dsh/package.json',import.meta.url));
export function createMoltbookTransport({proxy='http://127.0.0.1:7897'}={}){
 const {fetch,ProxyAgent}=require('undici');
 if(proxy!=='http://127.0.0.1:7897')throw Error('MOLTBOOK_REVIEWED_LOCAL_PROXY_REQUIRED');
 const dispatcher=new ProxyAgent(proxy);
 return {
  fetch:(url,init)=>{
   const target=new URL(url);
   if(target.origin!=='https://www.moltbook.com'||!target.pathname.startsWith('/api/v1/')||target.username||target.password)throw Error('MOLTBOOK_ORIGIN_REFUSED');
   return fetch(url,{...init,redirect:'error',dispatcher});
  },
  close:()=>dispatcher.close(),
 };
}
