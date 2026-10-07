import * as asar from 'file:///.local/unconfigured';
import {readFile, writeFile, mkdir, cp} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {Pickle} from 'file:///.local/unconfigured';
import {getFileIntegrityFromBuffer} from 'file:///.local/unconfigured';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const report = resolve(root, 'reports/multi-window');
const installed = '.local/unconfigured/app.asar';
let bundle = await readFile(resolve(report, 'installed-main-before.js'), 'utf8');
for (const name of ['directory-picker', 'microphone-permissions', 'locale', 'keyboard', 'main']) {
  let compiled = await readFile(resolve(report, `compiled/${name}.js`), 'utf8');
  compiled = compiled.replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, '').replace(/^export \{[\s\S]*?\};\s*$/m, '');
  assert(!/^import /m.test(compiled), name + ': remaining import');
  if (name === 'main') compiled = 'const WINDOWS_TITLEBAR_HEIGHT = 40;\n' + compiled;
  const marker = `//#region lib/types/${name}.js`;
  const start = bundle.indexOf(marker);
  const end = bundle.indexOf('//#endregion', start);
  assert(start >= 0 && end > start, name);
  bundle = bundle.slice(0, start) + marker + '\n' + compiled + bundle.slice(end);
}
await writeFile(resolve(report, 'installed-main-after.js'), bundle);
const payload = resolve(report, 'package-payload');
await mkdir(payload, {recursive:true});
// Retain the original payload and all unpack metadata; append only the new main bundle.
const entries = asar.listPackage(installed).map(path => path.replace(/^[/\\]/, ''));
const unpacked = entries.filter(path => asar.statFile(installed, path).unpacked && !asar.statFile(installed, path).files);
const original = await readFile(installed);
const raw = asar.getRawHeader(installed);
const body = original.subarray(8 + raw.headerSize);
const nextMain = Buffer.from(bundle);
const mainEntry = raw.header.files.lib.files['main.js'];
mainEntry.size = nextMain.length;
mainEntry.offset = String(body.length);
mainEntry.integrity = getFileIntegrityFromBuffer(nextMain);
const headerPickle = new Pickle();
headerPickle.writeString(JSON.stringify(raw.header));
const header = headerPickle.toBuffer();
const sizePickle = new Pickle();
sizePickle.writeUInt32(header.length);
await writeFile(resolve(report, 'app.asar'), Buffer.concat([sizePickle.toBuffer(), header, body, nextMain]));
await cp(installed + '.unpacked', resolve(report, 'app.asar.unpacked'), {recursive:true});
let verified = 0;
for (const path of entries) {
  const stat = asar.statFile(installed, path);
  if (stat.files || stat.link || path.replaceAll('\\', '/') === 'lib/main.js') continue;
  assert.deepEqual(asar.statFile(resolve(report, 'app.asar'), path), stat, path + ': metadata');
  verified++;
}
const packed = await readFile(resolve(report, 'app.asar'));
const packedHeader = asar.getRawHeader(resolve(report, 'app.asar'));
assert.deepEqual(packed.subarray(8 + packedHeader.headerSize, 8 + packedHeader.headerSize + body.length), body);
assert.deepEqual(asar.extractFile(resolve(report, 'app.asar'), 'lib/main.js'), nextMain);
await writeFile(resolve(report, 'package-verification.json'), JSON.stringify({observedAt:new Date().toISOString(), changedFiles:['lib/main.js'], unchangedFilesVerified:verified, unpackedFiles:unpacked.length}, null, 2));
console.log(JSON.stringify({unchangedFilesVerified:verified, unpackedFiles:unpacked.length}));
