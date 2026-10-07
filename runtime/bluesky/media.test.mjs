import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMedia } from './bundle/media.mjs';

test('real loopback gallery is browser-compatible, escapes foreign text, serves only prepared pages and closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-media-'));
  const media = createMedia({ root, readPost: async uri => ({ uri, cid: 'fixture-cid', author: { handle: 'fixture' },
    text: '<script>foreign()</script>', images: [{ fullsize: 'https://cdn.bsky.app/image.jpg', alt: '<bad>' }], url: 'https://bsky.app/profile/did:plc:a/post/a' }) });
  let gallery;
  try {
    const result = await media({ uri: 'at://did:plc:a/app.bsky.feed.post/a' }); gallery = result.browser_gallery;
    assert.match(gallery, /^http:\/\/127\.0\.0\.1:[0-9]+\/media\/[a-f0-9]+\.html$/);
    const response = await fetch(gallery); assert.equal(response.status, 200);
    const html = await response.text(); assert.ok(html.includes('https://cdn.bsky.app/image.jpg')); assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;')); assert.equal((await fetch(new URL('/media/unknown.html', gallery))).status, 404);
    assert.equal((await fetch(gallery, { method: 'POST' })).status, 404);
    assert.equal((await fetch(new URL('/.host-control.json', gallery))).status, 404);
    assert.ok(response.headers.get('content-security-policy').includes("form-action 'none'"));
  } finally { await media.close(); await rm(root, { recursive: true, force: true }); }
  await assert.rejects(fetch(gallery));
});

test('reviewed local JPEG sheet reaches a browser gallery without exposing filesystem paths',async()=>{
  const media=createMedia({root:tmpdir(),readPost:async()=>null});
  const bytes=Buffer.from([255,216,255,224,0,0,255,217]);
  try {
    const gallery=await media.previewJpeg(bytes);
    const response=await fetch(gallery),html=await response.text();
    assert.equal(response.status,200);assert.ok(!html.includes(tmpdir()));
    const asset=html.match(/<img src="([^"]+)"/)[1];
    const image=await fetch(new URL(asset,gallery));
    assert.equal(image.headers.get('content-type'),'image/jpeg');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()),bytes);
    assert.ok(response.headers.get('content-security-policy').includes("img-src 'self' https:"));
    await assert.rejects(media.previewJpeg(Buffer.from('not a JPEG')));
  } finally {await media.close();}
});
