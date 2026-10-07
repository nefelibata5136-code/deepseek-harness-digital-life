import {writeFile,unlink} from 'node:fs/promises';
export const inject=['connection','webServer'];
export async function apply(ctx){
 const path=new URL('../../../reports/self-recovery/.desktop-auth.json',import.meta.url);
 await writeFile(path,JSON.stringify({url:ctx.connection.authenticatedUrl('http://127.0.0.1:'+ctx.webServer.port+'/')}),{mode:0o600});
 ctx.effect(()=>()=>unlink(path).catch(()=>{}));
}
