import {mountBillingRuntime} from './runtime.mjs?release=3';
export const inject=['systemPrompt','tools'];
export async function apply(ctx,config={}){return mountBillingRuntime(ctx,{producer:config.producer===true});}
