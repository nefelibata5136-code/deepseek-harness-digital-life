/** Maintainer read/diagnostic commands; credentials stay in the existing broker. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { credentialOperation } from '../native_dsh/capabilities/isolation.mjs';
import { createHash } from 'node:crypto';
const source = '.local/workspace/development/plugins/persona-dots/plugin.mjs';
const { createBridge } = await import(pathToFileURL(source));
const python = (process.env.DL_PYTHON || 'python');
const credentials = { resolve: ref => credentialOperation(python,'resolve',ref) };
const bridge = await createBridge(credentials);
const [command = 'status', id, position = '0', version] = process.argv.slice(2);
try {
  let result;
  if (command === 'status') result = await bridge.health();
  else if (command === 'check') result = await bridge.check(id);
  else if (command === 'read') result = bridge.read(id,{offset:Number(position),version,reader:{actor:'maintainer'}});
  else if (command === 'history') result = bridge.history(id,Number(position));
  else if (command === 'handoff') result = bridge.handoff(id);
  else if (command === 'raw') result = {task_id:id,external:true,messages:bridge.store.messages(bridge.get(id).id)};
  else if (command === 'delegate') {
    const input = JSON.parse(await readFile(resolve(id),'utf8'));
    result = await bridge.delegate(input,{actor:'maintainer',note:'not an autonomous Persona native call'});
  } else if (command === 'export') {
    const after = Number(id ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new Error('INVALID_CURSOR');
    const rows = bridge.store.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 100').all(after);
    result = {source:'persona-dots',after,records:rows.map(row=>({
      id:`persona-dots:event:${row.seq}`,task_id:row.task_id,kind:row.kind,
      occurred_at:row.kind==='external_message'?null:row.observed_at,
      observed_at:row.observed_at,source_locator:{database:'tasks.sqlite3',table:'events',seq:row.seq},
      content:JSON.parse(row.value),content_hash:createHash('sha256').update(row.value).digest('hex'),deleted:false
    })),next_after:rows.length===100?rows.at(-1).seq:null,
    boundary:'local audit export only; not GitHub publication, unified exporter registration or verified Dots ingestion'};
  } else throw new Error('COMMAND_NOT_SUPPORTED');
  console.log(JSON.stringify(result,null,2));
} catch(error) {
  console.log(JSON.stringify({ok:false,code:/^[A-Z0-9_]+$/.test(error.message)?error.message:'LOCAL_OPERATION_FAILED'}));
  process.exitCode=1;
} finally { await bridge.close(); }
