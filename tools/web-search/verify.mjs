// Offline acceptance: run the real CLI against a deterministic fetch fixture.
// Creates only an isolated sibling fixture; never contacts a search provider.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(here, '.verify-'));
try {
  for (const name of ['search.mjs', 'policy.json']) copyFileSync(join(here, name), join(root, name));
  const fixture = join(root, 'fetch.mjs');
  writeFileSync(fixture, `globalThis.fetch = async url => ({status:200,text:async()=>'<p>'+ '正文🙂'.repeat(2500) +'</p>',json:async()=>({hits:Array.from({length:Number(new URL(url).searchParams.get('hitsPerPage'))},(_,i)=>({title:'Result '+i,objectID:i}))})});`);
  // Restricted Windows Node cannot create child capture pipes. Inherit file
  // handles and read the explicit fixture files after process completion.
  const child = args => {
    const out=join(root,'stdout.txt'),err=join(root,'stderr.txt');
    const stdout=openSync(out,'w'),stderr=openSync(err,'w');
    let result;
    try {result=spawnSync(process.execPath,['--preserve-symlinks-main','--preserve-symlinks',...args],{stdio:['ignore',stdout,stderr],windowsHide:true});}
    finally {closeSync(stdout);closeSync(stderr);}
    return {...result,stdout:readFileSync(out,'utf8'),stderr:readFileSync(err,'utf8')};
  };
  const run = (...args) => {
    const out = child(['--import', pathToFileURL(fixture).href, join(root, 'search.mjs'), ...args]);
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const original = JSON.parse(readFileSync(join(root, 'policy.json'), 'utf8'));
  assert.deepEqual(run('--describe').policy, original);
  const first = run('--page=https://fixture.invalid', '--json');
  assert.equal(first.text.length, original.pageChars);
  assert.equal(first.next_offset, original.pageChars);
  const second = run('--page=https://fixture.invalid', '--json', '--offset='+first.next_offset);
  assert.equal((first.text + second.text).length, first.total_chars);
  assert.equal(second.next_offset, null);
  writeFileSync(join(root, 'policy.json'), JSON.stringify({...original,pageChars:1234,defaultResults:3}));
  assert.equal(run('--page=https://fixture.invalid','--json').text.length,1234);
  assert.equal(run('query','--src=hn','--json').count,3);
  assert.equal(run('query','--src=hn','--n=2','--json').count,2);
  writeFileSync(join(root, 'policy.json'), JSON.stringify({...original,attempts:0}));
  const invalid=child([join(root,'search.mjs'),'--describe']);
  assert.notEqual(invalid.status,0);
  console.log(JSON.stringify({passed:true,checks:7,externalRequests:0,fixtureOnly:true}));
} finally {
  const rel=relative(resolve(here),resolve(root));
  if (rel.startsWith('.verify-') && !rel.includes('..')) rmSync(root,{recursive:true,force:true});
}
