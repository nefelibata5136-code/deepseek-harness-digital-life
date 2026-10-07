import net from 'node:net';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, controlPipe } from './supervisor.mjs';

export async function control(config, command = 'status') {
  if (!['status', 'stop', 'disable', 'enable'].includes(command)) throw new Error('Unknown control command');
  const disabled = resolve(config.stateDir, 'disabled');
  if (command === 'enable') {
    await unlink(disabled).catch(error => { if (error.code !== 'ENOENT') throw error; });
    return { enabled: true, started: false };
  }
  try {
    return await new Promise((yes, no) => {
      const socket = net.connect(controlPipe(config)); let data = '';
      socket.setTimeout(3000); socket.once('error', no); socket.once('timeout', () => { socket.destroy(); no(new Error('Control timeout')); });
      socket.once('connect', () => socket.write(command + '\n'));
      socket.on('data', bytes => { data += bytes; });
      socket.once('end', () => { try { yes(JSON.parse(data)); } catch (error) { no(error); } });
    });
  } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error;
    if (command === 'disable') { await mkdir(config.stateDir, { recursive: true }); await writeFile(disabled, 'disabled by control\n'); }
    let last = null;
    try { last = JSON.parse(await readFile(resolve(config.stateDir, 'runtime.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { live: false, command, last, note: 'Saved PID is historical and is not live-process evidence.' };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await control(await readConfig(resolve(process.argv[2])), process.argv[3] ?? 'status'), null, 2));
}
