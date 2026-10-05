// Windows desktop capability in Persona's existing native Agent loop.
import * as NativeComputer from '@deepseek-ai/dsh-experimental-computer-use-cua-driver-native';
import { windowsDpi } from './windows-dpi.mjs';
import { createDesktopOverlay } from './desktop-overlay.mjs';

export const inject = ['computerUse', 'tools', 'systemPrompt', 'workspaceFoundation', 'attachments'];
export const desktopTools = [
  'list_apps', 'list_windows', 'get_desktop_state', 'get_window_state', 'verify_state',
  'launch_app', 'bring_to_front', 'set_window_frame', 'click', 'double_click',
  'right_click', 'drag', 'move_cursor', 'scroll', 'type_text', 'press_key',
  'hotkey', 'get_screen_size', 'get_cursor_position', 'zoom', 'check_permissions',
].map(name => 'cua_driver_native__' + name);
const observes = new Set(['get_desktop_state', 'get_window_state', 'verify_state',
  'list_apps', 'list_windows', 'get_screen_size', 'get_cursor_position', 'zoom', 'check_permissions']
  .map(name => 'cua_driver_native__' + name));

const browserObserves = new Set(['browser_get_state','browser_read_page','browser_status','browser_list_tabs']
  .map(name=>'mcp__persona_browser__'+name));
/** Mount the released provider and serialize its work; no model or conversation loop. */
export async function apply(ctx, config = {}) {
  let enabled = true;
  let pending = Promise.resolve();
  let active = new AbortController();
  const overlay = config.visualIndicator === false ? undefined : await createDesktopOverlay();
  let overlayOwner;
  ctx.effect(() => () => overlay?.dispose(), 'persona desktop indicator');
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && session.id === overlayOwner) {
      overlayOwner = undefined;
      overlay?.hide().catch(()=>{});
    }
  });
  const provider = ctx.plugin(NativeComputer);
  ctx.effect(() => provider.dispose, 'persona computer provider');
  await provider;
  ctx.provide('personaComputer', {
    status: () => ({ enabled, provider: ctx.computerUse.providerName, platform: process.platform,
      tools: desktopTools, display: 'primary', sharedDesktop: true, dpi:windowsDpi,
      indicator:overlay?.status() ?? {enabled:false} }),
    setEnabled(value) {
      if (typeof value !== 'boolean') throw new Error('enabled must be boolean');
      enabled = value;
      if (!enabled) { active.abort(new Error('Windows desktop operation paused by user')); overlayOwner=undefined; overlay?.hide().catch(()=>{}); }
      else if (active.signal.aborted) active = new AbortController();
      return this.status();
    },
  });
  ctx.on('tools/execute', async (exec, next) => {
    const native = exec.name.startsWith('cua_driver_native__');
    const browser = exec.name.startsWith('mcp__persona_browser__');
    if (!native && !browser) return next();
    if (!config.fullAccess && native && !desktopTools.includes(exec.name)) throw new Error('Desktop tool outside reviewed catalog');
    if (!enabled) throw new Error('Windows desktop operation is paused');
    const prior = pending;
    let done;
    pending = new Promise(resolve => { done = resolve; });
    const upstream = exec.signal;
    exec.signal = AbortSignal.any([upstream, active.signal]);
    try {
      await prior;
      exec.signal.throwIfAborted();
      if (overlay) { overlayOwner=exec.agent.session.id;await overlay.show();exec.signal.throwIfAborted(); }
      if (!observes.has(exec.name) && !browserObserves.has(exec.name)) {
        ctx.workspaceFoundation.assertHealthy();
        ctx.workspaceFoundation.run('snapshot', '--reason', 'before-gui:' + exec.name);
      }
      try { return await next(); }
      finally {
        if (!observes.has(exec.name) && !browserObserves.has(exec.name)) ctx.workspaceFoundation.run('snapshot', '--reason', 'after-gui:' + exec.name);
      }
    } finally { exec.signal = upstream; done(); }
  });
  ctx.effect(() => async () => { enabled = false; active.abort(); await pending; }, 'persona computer calls');
  // Native MCP text rendering omits structuredContent, including the snapshot id
  // required by indexed actions. Publish that metadata with the durable image.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (decision.kind !== 'accept' || result.isError || !desktopTools.includes(exec.name)) return decision;
    const raw = result.value;
    const state = raw?.structuredContent;
    if (!state || !['get_window_state','get_desktop_state','list_windows','verify_state'].some(n=>exec.name.endsWith('__'+n))) return decision;
    const images = (raw.content ?? []).filter(b=>b.type==='image');
    const refs = await ctx.attachments.saveImages(images.map(b=>({data:Buffer.from(b.data,'base64'),mediaType:b.mimeType})));
    let index=0;
    const content=(raw.content ?? []).filter(b=>['text','image'].includes(b.type)).map(b=>b.type==='image'
      ? {type:'image',attachment:refs[index++]} : {type:'text',text:b.text});
    const metadata=Object.fromEntries(Object.entries(state).filter(([key])=>!['elements','tree_markdown'].includes(key)));
    content.push({type:'text',text:'Desktop observation metadata (use this snapshot_id with element_index):\n'+JSON.stringify(metadata)});
    return {kind:'accept',content,...(decision.additionalContexts?{additionalContexts:decision.additionalContexts}:{})};
  });
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'persona:windows-desktop', order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') + 1,
    text: `你现在可以直接观察和操作用户当前登录的 Windows 桌面。这是你自己的工具，仍由同一个人格 Agent 决定和执行，没有另一个代操作 Agent。
先用 cua_driver_native__get_desktop_state 看真实桌面，用 list_windows 找准确 pid/window_id。可 launch_app 打开本地软件；先观察窗口再操作，操作后再截图确认结果，按当前画面继续。get_window_state 的 UIA 文字辅助定位，但必须与截图核对；没有 UIA 的界面用截图和鼠标。
窗口坐标来自该窗口最新截图，桌面坐标来自最新完整桌面截图；注意 screenshot_scale、window_bounds 和图像尺寸，不猜系统缩放。长任务可逐步自动完成，无需每步问用户。
用户已授权此能力的普通桌面输入、打开软件和切换窗口。窗口输入先用 background；工具明确拒绝或观察证实没有效果后，同一步可以 foreground 重试。桌面 target={kind:"desktop",display_id:"primary"} 用于任务栏、系统热键与跨窗口拖拽；它会使用真实鼠标和当前前台。与用户共享桌面，看到用户改变状态时重新观察。键盘 win 即 Windows 键。
软件界面有自己的文件权限，GUI 与 terminal 均按当前用户的真实权限操作。保护既有文件和未保存编辑；其他工作区建议保留原件，按 AGENTS.md 行为建议行动。不要查看或转录凭据、登录秘密；付款、对外发消息、删除用户资料、系统安全授权需遵守当前任务授权。UAC安全桌面、锁屏或更高权限程序拒绝时说明实际限制，不自动提权。
Delivered 或 effect=unverifiable 只表示输入送达，不代表任务完成；必须依据新画面或实际文件确认。暂停后不能继续桌面动作，取消不能撤销已送达输入。截图由官方附件库保存并随原生工具结果入会话历史，直接交给当前 DeepSeek 视觉模型。
只在任务需要时观察桌面，没有后台定时截图。`,
  }), 'persona desktop guidance');
}
