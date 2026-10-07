// Independent real Cordis worker; shared native durable-image store, no model request.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
const nativeRequire=createRequire(new URL('../native_dsh/package.json',import.meta.url));
const {createBus}=await import('../native_dsh/capabilities/bus.mjs');
const {Context}=await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/cordis')));
const {default:Attachments}=await import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/dsh-attachment-local')));
const base='.';
const bus=createBus({root:base+'/runtime/native_dsh/capabilities/profiles',python:'python'});
const storeCtx=new Context();
try {
  await storeCtx.plugin(Attachments,{dshHome:base+'/runtime/native_dsh/home'});
  await bus.manage({action:'enable',capability:'xiaohongshu'});
  const found=await bus.search({capability:'xiaohongshu',limit:30});
  assert.equal(found.tools.length,16);
  assert.ok(found.tools.every(t=>t.name.startsWith('cap__xiaohongshu__xhs_')));
  const run=async(name,args={})=>{
    const r=await bus.call('xiaohongshu','xhs_'+name,args,'technical-xhs-'+name);
    const data=JSON.parse(r.content.find(x=>x.type==='text').text);
    assert.equal(data.ok,true,JSON.stringify(data));return {result:r,data:data.data};
  };
  await run('check_login_status');
  const feed=await run('list_feeds',{limit:3});
  const note=await run('get_feed_detail',{note_ref:feed.data.items[0].note_ref});
  const image=await run('read_images',{note_ref:note.data.note_ref,limit:1});
  const file=image.data.image_files?.[0];
  assert.ok(file?.attachment,'No durable native image stored through capability worker');
  const bytes=await storeCtx.attachments.readImage(file.attachment);
  assert.ok(bytes.data.length>1000);
  const report={passed:true,model_called:false,tools:found.tools.map(t=>({name:t.name,parameters:t.parameters})),
    worker_image_stored:true,model_image_entry:'read_image',main_store_reads_same_attachment:true,image_bytes:bytes.data.length,image_sha256:file.attachment.id,
    note_ref:note.data.note_ref,title:note.data.title};
  await mkdir(base+'/reports/xiaohongshu',{recursive:true});
  await writeFile(base+'/reports/xiaohongshu/worker-acceptance.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({passed:true,tool_count:16,worker_image_stored:true,model_image_entry:'read_image',main_store_reads_same_attachment:true,image_bytes:bytes.data.length}));
} finally {await bus.dispose();await storeCtx.fiber.dispose();}
