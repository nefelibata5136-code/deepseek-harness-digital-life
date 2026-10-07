export function waitForBillingResponse(page,received,{timeout=25000}={}){
 const login=page.waitForURL(url=>/^\/(?:sign[_-]?in|login)(?:\/|$)/i.test(url.pathname),{timeout}).then(()=>{throw Error('BILLING_LOGIN_REQUIRED');});
 login.catch(()=>{});received.catch(()=>{});
 return Promise.race([received,login]);
}
