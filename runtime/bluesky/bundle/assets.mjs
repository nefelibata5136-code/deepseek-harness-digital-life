import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute, extname, basename } from 'node:path';
const require = createRequire(new URL('../../native_dsh/package.json', import.meta.url));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const WORKSPACE = '.local/workspace';
const assetId = id => /^[a-f0-9-]{36}$/.test(id ?? '') ? id : fail('INVALID_ASSET_ID');
async function sourceFile(input, extensions, maxBytes) {
  if (isAbsolute(input) || input.split(/[\\/]/).some(p => p === '..' || p.startsWith('.'))) fail('USE_ORDINARY_WORKSPACE_RELATIVE_MEDIA_PATH');
  const base = await realpath(WORKSPACE), path = await realpath(resolve(base, input)), within = relative(base,path);
  if (!within || within.startsWith('..') || isAbsolute(within) || /(?:credential|secret|private|vault|session)/i.test(within)) fail('MEDIA_PATH_OUTSIDE_ALLOWED_WORKSPACE');
  if (!extensions.includes(extname(path).toLowerCase())) fail('MEDIA_FILE_TYPE_NOT_SUPPORTED');
  const info = await stat(path); if (!info.isFile() || info.size > maxBytes) fail('MEDIA_FILE_TOO_LARGE');
  return { path, bytes: await readFile(path) };
}
export function createAssets({ root, uploadBlob, videoUpload, videoStatus, videoLimits }) {
  const save = async data => { const id = randomUUID(); await mkdir(root,{recursive:true}); await writeFile(resolve(root,'asset-'+id+'.json'),JSON.stringify(data),{mode:0o600}); return {asset_id:id,...data}; };
  const read = async id => JSON.parse(await readFile(resolve(root,'asset-'+assetId(id)+'.json'),'utf8'));
  return {
    read,
    async images({ images }, signal) {
      const sharp = require('sharp'); const assets = [];
      for (const image of images) {
        const source = await sourceFile(image.path,['.jpg','.jpeg','.png','.webp'],20_000_000);
        const decoded = sharp(source.bytes,{limitInputPixels:40_000_000}).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true});
        let bytes = await decoded.jpeg({quality:85}).toBuffer();
        if (bytes.length > 1_000_000) bytes = await sharp(bytes).jpeg({quality:65}).toBuffer();
        if (bytes.length > 1_000_000) fail('IMAGE_TOO_LARGE_AFTER_ENCODING');
        const info = await sharp(bytes).metadata();
        const blob = await uploadBlob(bytes,'image/jpeg',signal);
        assets.push(await save({ kind:'image',blob,alt:image.alt ?? '',aspectRatio:{width:info.width,height:info.height},
          sha256:createHash('sha256').update(bytes).digest('hex'),originalPreserved:true }));
      }
      return {ok:true,assets,next:'Pass these asset_id values to post(image_assets). Upload alone does not publish a post.'};
    },
    async limits(_args,signal) { return videoLimits(signal); },
    async video({ path, alt = '', width, height }, signal) {
      const limits = await videoLimits(signal); if (!limits.emailConfirmed) fail('VIDEO_REQUIRES_VERIFIED_EMAIL');
      if (!limits.canUpload) fail('VIDEO_UPLOAD_NOT_ALLOWED_BY_SERVICE');
      const source = await sourceFile(path,['.mp4'],100_000_000);
      if (source.bytes.length < 12 || source.bytes.toString('ascii',4,8)!=='ftyp') fail('MP4_FILE_SIGNATURE_REQUIRED');
      const job = await videoUpload(source.bytes,basename(source.path),signal);
      return save({kind:'video',job_id:job.jobId,blob:job.blob,alt,
        ...(width&&height ? {aspectRatio:{width,height}} : {}),state:job.state,
        next:'Use video_status(asset_id) for bounded polling, then post(video_asset) after blob is ready.'});
    },
    async status({ asset_id },signal) {
      const a = await read(asset_id); if(a.kind!=='video')fail('VIDEO_ASSET_REQUIRED');
      const job = a.blob ? a : await videoStatus(a.job_id,signal);
      const after = {...a,blob:job.blob,state:job.state};
      await writeFile(resolve(root,'asset-'+assetId(asset_id)+'.json'),JSON.stringify(after),{mode:0o600});
      return {asset_id,...after,ready:!!after.blob};
    },
  };
}
