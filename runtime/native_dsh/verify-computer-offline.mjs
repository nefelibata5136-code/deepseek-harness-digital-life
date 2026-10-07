// Real native provider, isolated workspace/ledger, no model request or desktop input.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootNative, here } from './boot-native.mjs';
import * as Computer from './computer-host.mjs';

const root = resolve(here, '../../reports/task_A/computer-' + randomUUID());
const workspace = resolve(root, 'workspace');
await mkdir(workspace, {recursive:true});
await writeFile(resolve(workspace, 'persona-core.md'), '# Isolated computer provider test\n');
await writeFile(resolve(workspace, 'AGENTS.md'), '# No model calls\n');
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
const id = randomUUID();
const ctx = await bootNative({sessionId:id, testRoot:root});
try {
  assert(!ctx.get('personaComputer'), 'Fixture accidentally mounted the real desktop');
  await ctx.plugin(Computer, {visualIndicator:false});
  await ctx.sessionController.create({sessionId:id, cwd:workspace});
  const {agent} = await ctx.sessionController.resolveAgent(id);
  const names = agent.ctx.tools.schemas(agent).map(t=>t.name);
  for (const name of Computer.desktopTools) assert(names.includes(name), name);
  assert(!names.includes('cua_driver_native__page'));
  assert(!names.includes('cua_driver_native__kill_app'));
  const call = (name, args={}) => ctx.tools.execute({name:'cua_driver_native__'+name, arguments:args,
    callId:randomUUID(), agent, signal:new AbortController().signal});
  const permission = await call('check_permissions');
  assert(!permission.isError, JSON.stringify(permission.content));
  const screenshot = await call('get_desktop_state');
  assert(!screenshot.isError, JSON.stringify(screenshot.content));
  const image = screenshot.content.find(b=>b.type==='image');
  assert(image?.attachment, 'Screenshot must be a durable image, not a diagnostic');
  assert.equal(image.attachment.width, ctx.personaComputer.status().dpi.physicalScreen.width);
  assert.equal(image.attachment.height, ctx.personaComputer.status().dpi.physicalScreen.height);
  assert(screenshot.content.some(b=>b.type==='text' && b.text.includes('Desktop observation metadata')));
  const windows = await call('list_windows', {on_screen_only:true});
  const observed = windows.content.find(b=>b.type==='text' && b.text.startsWith('Desktop observation metadata'));
  assert(observed, 'Window geometry must reach the model, not only the canonical value');
  const visible = JSON.parse(observed.text.split('\n').slice(1).join('\n')).windows;
  const target = visible.find(w=>w.title.includes('desktop-acceptance'));
  if (target) {
    const state = await call('get_window_state', {pid:target.pid,window_id:target.window_id,max_elements:80});
    const meta = state.content.find(b=>b.type==='text' && b.text.startsWith('Desktop observation metadata'));
    assert(JSON.parse(meta.text.split('\n').slice(1).join('\n')).snapshot_id, 'Indexed inputs need a model-visible snapshot id');
    assert(state.content.some(b=>b.type==='image'), 'Adding metadata must preserve the screenshot');
  }
  const stored = await ctx.attachments.readImage(image.attachment);
  assert.equal('sha256:' + createHash('sha256').update(stored.data).digest('hex'), image.attachment.attachmentId);
  await writeFile(resolve(here,'../../reports/windows_computer/desktop-provider.png'), stored.data);
  ctx.personaComputer.setEnabled(false);
  const paused = await call('get_desktop_state');
  assert(paused.isError && JSON.stringify(paused.content).includes('paused'));
  ctx.personaComputer.setEnabled(true);
  assert(! (await call('get_screen_size')).isError);
  const forbidden = await call('kill_app', {pid:process.pid});
  assert(forbidden.isError);
  const result = {passed:true, observedAt:new Date().toISOString(), root, paidModelCalls:0,
    desktopInputSent:false, provider:ctx.personaComputer.status(), allowedAgentTools:names,
    screenshot:image.attachment, durableImageHashVerified:true, pausedCallsRefused:true,
    resumedReadSucceeded:true, unreviewedToolRefused:true, fixtureDesktopDisabledByDefault:true,
    permissions:permission.content};
  await writeFile(resolve(here, '../../reports/windows_computer/offline-validation.json'), JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {await ctx.fiber.dispose();}
