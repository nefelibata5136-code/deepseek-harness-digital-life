// Local Chrome expert translation model. No cloud/provider fallback or session writes.
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {redactThinking} from './thinking.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('./translation-ui/node_modules/playwright-core');
const profile='.local/unconfigured/chrome-profile';
let initialization,context,page,server;
let queue=Promise.resolve();
const cache=new Map();
async function initialize(){
 await mkdir(profile,{recursive:true});
 server=createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<button id="start">启用本地翻译模型</button>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',viewport:{width:400,height:200}});
 page=context.pages()[0]??await context.newPage();
 page.on('console',message=>{if(message.type()==='error')console.warn('[Persona local translation]',message.text());});
 await page.goto('http://127.0.0.1:'+server.address().port);
 const available=await page.evaluate(async()=>('Translator' in self)?await Translator.availability({sourceLanguage:'en',targetLanguage:'zh'}):'missing');
 if(['missing','unavailable'].includes(available))throw Error('本机 Chrome 英译中模型不可用');
 await page.evaluate(()=>{document.querySelector('#start').onclick=()=>{window.__ready=Translator.create({sourceLanguage:'en',targetLanguage:'zh'}).then(t=>{window.__translator=t;return true;});};});
 await page.locator('#start').click();
 await page.evaluate(()=>window.__ready);
 context.on('close',()=>{initialization=null;page=null;});
 return true;
}
async function ensure(){if(!initialization)initialization=initialize().catch(async e=>{await closeTranslation();throw e;});return initialization;}
export async function closeTranslation(){initialization=null;const c=context;context=null;page=null;await c?.close().catch(()=>{});if(server){const s=server;server=null;await new Promise(r=>s.close(r));}}
export async function translateThinking(input){
 if(typeof input!=='string'||!input.trim()||input.length>6000)throw Error('思考翻译片段长度无效');
 const text=redactThinking(input),key=createHash('sha256').update(text).digest('hex');
 if(cache.has(key))return {text:cache.get(key),local:true,engine:'Chrome Translator',cached:true};
 const task=queue.catch(()=>{}).then(async()=>{
  await ensure();
  // Keep code, URLs and explicit paths intact; translate surrounding prose only.
  const pieces=text.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s]+|[A-Za-z]:[\\/][^\s]+|(?:\.{0,2}\/)[A-Za-z0-9_./-]+)/g);
  const translated=[];
  for(let i=0;i<pieces.length;i++){
   const p=pieces[i];if(i%2||!/[A-Za-z]{3}/.test(p)){translated.push(p);continue;}
   translated.push(await page.evaluate(t=>window.__translator.translate(t),p));
  }
  const result=redactThinking(translated.join(''));cache.set(key,result);if(cache.size>400)cache.delete(cache.keys().next().value);
  return {text:result,local:true,engine:'Chrome Translator',cached:false};
 });
 queue=task;return task;
}
