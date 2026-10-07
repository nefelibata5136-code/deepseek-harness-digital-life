import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveAttachment,readReceipt,saveClipboard,attachmentPrompt,maxBytes} from './store.mjs';

test('pasted image, document, audio and video preserve bytes and separate sessions',async()=>{
  const root=await mkdtemp(resolve(tmpdir(),'yb-paste-')),sessionId=randomUUID(),other=randomUUID();
  try {
    const receipts=[];
    for(const [name,type] of [['截图.png','image/png'],['receipt.json','application/json'],['录音.wav','audio/wav'],['视频.mp4','video/mp4']]) {
      const bytes=Buffer.from([0,255,3,4,77,21]);
      const file=await saveAttachment(root,sessionId,{name,type,bytes});receipts.push(file);
      assert.deepEqual(await readFile(file.path),bytes);assert.equal(file.size,bytes.length);
      assert.deepEqual(await readReceipt(root,sessionId,file.id),file);
      await assert.rejects(readReceipt(root,other,file.id));
    }
    const duplicate=await saveAttachment(root,sessionId,{name:'截图.png',bytes:Buffer.from('different')});
    assert.notEqual(duplicate.path,receipts[0].path);
    const prompt=await attachmentPrompt(root,sessionId,'测试附件',receipts.map(r=>r.id));
    for(const file of receipts)assert(prompt.includes(JSON.stringify(file.path)));
    assert(prompt.includes('音视频上传成功不代表已识别'));
    await assert.rejects(saveAttachment(root,'../../invalid',{name:'x',bytes:Buffer.from('x')}));
    await assert.rejects(readReceipt(root,sessionId,'../../invalid'));
    await assert.rejects(saveAttachment(root,sessionId,{name:'x',bytes:Buffer.alloc(0)}));
    await assert.rejects(saveAttachment(root,sessionId,{name:'x',bytes:{length:maxBytes+1}}));
    const local=resolve(root,'本地文件.txt');await writeFile(local,'原始文件');
    const copied=await saveClipboard(root,sessionId,{paths:[local,root,resolve(root,'missing')]});
    assert.equal(copied.files.length,1);assert.equal(copied.errors.length,2);
    assert.equal(await readFile(copied.files[0].path,'utf8'),'原始文件');
    const image=await saveClipboard(root,sessionId,{image:Buffer.from('png fixture').toString('base64')});
    assert.equal(await readFile(image.files[0].path,'utf8'),'png fixture');
  }finally{await rm(root,{recursive:true,force:true});}
});
