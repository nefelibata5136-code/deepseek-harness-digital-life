import '../windows-dpi.mjs';
import { CuaDriver } from '@trycua/cua-driver';
import { writeFile } from 'node:fs/promises';
const driver = CuaDriver.create();
try {
  const call = async (name, args = {}) => JSON.parse((await driver.callTool(name, JSON.stringify(args))).rawJson);
  const windows = (await call('list_windows')).structuredContent.windows;
  const window = windows.find(w => w.title === 'DeepSeek Harness' && w.app_name === 'DeepSeek Harness.exe');
  if (!window) throw new Error('Installed desktop window missing');
  const args = { pid: window.pid, window_id: window.window_id };
  await call('bring_to_front', args);
  if (process.argv[2] === '--reload') await call('hotkey', { ...args, keys: ['CTRL', 'R'] });
  if (process.argv[2] === '--hotkey') await call('hotkey', { ...args, keys: process.argv.slice(3) });
  let state = await call('get_window_state', { ...args, max_elements: 1500, max_dimension: 1568 });
  if (process.argv[2] === '--point') {
    const result = await call('click', { ...args, x:Number(process.argv[3]), y:Number(process.argv[4]), ...(process.argv[5] ? {delivery_mode:process.argv[5]} : {}) });
    if(result.isError) throw new Error(JSON.stringify(result.structuredContent));
    state = await call('get_window_state', { ...args, max_elements: 1500, max_dimension: 1568 });
    const desktop = await call('get_desktop_state');
    const capture = desktop.content.find(b=>b.type === 'image');
    if(capture) await writeFile(new URL('../../../reports/digital-life/reconnect-20261005/menu.png',import.meta.url), Buffer.from(capture.data,'base64'));
  }
  if (['--click', '--click-last'].includes(process.argv[2])) {
    const matches = state.structuredContent.elements.filter(e => e.label === process.argv[3]);
    const element = process.argv[2] === '--click-last' ? matches.at(-1) : matches[0];
    if (!element) throw new Error('Control unavailable: ' + process.argv[3]);
    const result = await call('click', { ...args, element_index: element.element_index, snapshot_id: state.structuredContent.snapshot_id });
    if (result.isError) throw new Error('Actual desktop click failed');
    state = await call('get_window_state', { ...args, max_elements: 1500, max_dimension: 1568 });
  }
  const image = state.content.find(b => b.type === 'image');
  if (image) await writeFile(new URL('../../../reports/digital-life/desktop-latest.png', import.meta.url), Buffer.from(image.data, 'base64'));
  const elements = state.structuredContent.elements;
  console.log(JSON.stringify({ actualDesktop: true, pid: window.pid,
    connectionLabels: elements.filter(e => /已连接人格|常驻服务|人格正在启动|连接恢复|会话暂时无法载入|旧运行环境|重新连接/.test(e.label ?? '')).map(e => e.label).slice(0,10),
    labels: elements.filter(e => /button|combobox|radio|tab|menu|heading/i.test(e.role ?? e.control_type ?? e.type ?? '')).map(e => ({ label: e.label, role: e.role ?? e.control_type ?? e.type })),
    matches: elements.filter(e => /数字生命|Persona|意识席位|活动结果|待接续|Agent 预设|Agent Preset|Default agent/i.test(e.label ?? '')).map(e => e.label).slice(0,35) }));
} finally { await driver.shutdown(); driver.uniffiDestroy(); }
