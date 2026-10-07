import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
export function billingEnvironment(){
 const allowed=['DL_WORLD_ROOT','DL_DATA','DL_PYTHON','DL_BILLING_PROFILE','PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA'];
 const settings=JSON.parse(readFileSync(resolve(process.env.DL_WORLD_ROOT||'.local/world','settings.json'),'utf8'));
 for(const life of settings.lives){if(!/^DL_DEEPSEEK_KEY_[A-Z][A-Z0-9_]*$/.test(life.keyEnv))throw Error('EXPLICIT_BILLING_KEY_ENV_REQUIRED');allowed.push(life.keyEnv);}
 return Object.fromEntries(Object.entries(process.env).filter(([k])=>allowed.includes(k.toUpperCase())));
}
