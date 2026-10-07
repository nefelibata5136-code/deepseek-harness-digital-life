/** Maintainer CLI; live actions use the existing authenticated loopback Host. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBus } from './bus.mjs';
import { registerProfile, approveProfile, withManager, readEntry, saveEntry } from './profiles.mjs';

const config = {
  root: resolve(import.meta.dirname, 'profiles'),
  python: 'python',
};
const [command = 'list', id, target, ...rest] = process.argv.slice(2);
const bus = createBus(config);
const live = async (method, input) => {
  const state = JSON.parse(await readFile(resolve(import.meta.dirname, '../host-state/.host-control.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${state.port}/capabilities`, {
    method, headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error('Live capability management failed: HTTP ' + response.status);
  return response.json();
};
try {
  let result;
  if (command === 'list') result = await bus.list();
  else if (command === 'live-list') result = await live('GET');
  else if (command === 'register') result = await registerProfile(config.root,
    { id, kind: target, description: rest[0] ?? id, credentialRefs: rest.slice(1) });
  else if (command === 'install') result = await bus.manage({ action: 'install_bundle', capability: id, target });
  else if (command === 'select') {
    result = await withManager(config.root, id, manager => manager.setBundleEnabled(target, true));
    const entry = await readEntry(config.root, id); entry.approval = null; entry.enabled = false;
    await saveEntry(config.root, entry);
  } else if (command === 'approve') result = await approveProfile(config.root, id);
  else if (['enable', 'disable', 'refresh', 'list_plugins', 'list_bundles', 'inspect'].includes(command))
    result = await live('POST', { action: command, capability: id, ...(target ? { target } : {}) });
  else throw new Error('Commands: list, live-list, register, install, select, approve, enable, disable, refresh, list_plugins, list_bundles, inspect');
  console.log(JSON.stringify(result, null, 2));
} finally { await bus.dispose(); }
