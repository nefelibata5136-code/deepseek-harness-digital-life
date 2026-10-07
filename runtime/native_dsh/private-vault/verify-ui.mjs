// Inspect the actual installed Electron window, not a parallel UI replica.
import '../windows-dpi.mjs';
import assert from 'node:assert/strict';
import { CuaDriver } from '@trycua/cua-driver';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const driver = CuaDriver.create();
const call = async (name, args = {}) => {
  const result = JSON.parse((await driver.callTool(name, JSON.stringify(args))).rawJson);
  assert(!result.isError, 'Desktop inspection failed'); return result;
};
try {
  const windows = (await call('list_windows')).structuredContent.windows;
  const app = windows.find(window => window.title === 'DeepSeek Harness' && window.app_name === 'DeepSeek Harness.exe');
  assert(app, 'Actual installed Harness window missing');
  const args = { pid: app.pid, window_id: app.window_id };
  await call('bring_to_front', args);
  let state = await call('get_window_state', { ...args, max_elements: 300, max_dimension: 1280 });
  const tab = state.structuredContent.elements.find(element => element.label === '人格');
  if (tab) {
    await call('click', { ...args, element_index: tab.element_index, snapshot_id: state.structuredContent.snapshot_id });
    state = await call('get_window_state', { ...args, max_elements: 300, max_dimension: 1280 });
  }
  const controls = state.structuredContent.elements.filter(element => /button|textbox|menuitem/i.test(element.role ?? element.control_type ?? element.type ?? ''));
  assert(state.structuredContent.elements.some(element => /给人格的消息|人格主对话/.test(element.label ?? '')), 'Persona page must actually be selected');
  const forbidden = /查看私人|私人日记|打开明文|导出私人|导出明文|万能密码|decrypt|vault.*(?:read|export)/i;
  assert(!controls.some(control => forbidden.test(control.label ?? '')), 'Private content entry point found');
  const source = await readFile(resolve(import.meta.dirname, '../../desktop_persona/index.mjs'), 'utf8');
  assert(!source.includes('private_read') && !source.includes('private_write') && !source.includes('PrivateVaultStore'), 'Desktop imports private dispatch');
  const proof = { passed: true, checkedAt: new Date().toISOString(), actualInstalledElectron: true,
    appPid: app.pid, personaPageActuallySelected: true, inspectedElements: state.structuredContent.elements.length, inspectedControls: controls.length,
    privateContentEntryAbsent: true, desktopDoesNotImportVaultStoreOrTools: true, paidModelCalls: 0 };
  await writeFile(resolve(import.meta.dirname, '../../../reports/private-vault/ui.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally { await driver.shutdown(); driver.uniffiDestroy(); }
