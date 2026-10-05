// Native DSH extension only: no model transport, conversation loop or history injection.
import { readFileSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { lifeTools } from './digital-life/plugin.mjs';

export const inject = ['tools', 'systemPrompt', 'workspaceFoundation'];
const s = (required = false) => ({ type: 'string', ...(required ? { required: true } : {}) });
const n = () => ({ type: 'integer' });
export const baselineToolNames = ['list_files', 'read', 'read_source', 'search_history', 'write', 'terminal',
  'edit', 'skill', 'budget_status', 'schedule_create', 'schedule_list', 'schedule_update', 'schedule_delete',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read', 'task_list', 'task_create', 'context_compact',
  'context_compact_prepare', 'context_compact_commit', 'context_compact_status', 'context_compact_read',
  'recovery_diagnostics', 'recovery_checkpoint', 'recovery_resume',
  'capability_list', 'capability_search', 'capability_manage', 'digital_life_state_read', 'digital_life_state_update',
  'private_write', 'private_read', 'private_search', 'private_list', 'private_delete',
  'subagent', 'send_message', 'list_agents', 'interrupt_agent', 'subagent_codex'];

export function apply(ctx, config) {
  // Composition is deployment-owned. B/C hand off reviewed tool names here;
  // workspace text and model arguments cannot widen the runtime permissions.
  const toolNames = [...baselineToolNames, ...lifeTools, ...(config.additionalTools ?? [])];
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    ['DL_PYTHON', 'DL_WORKSPACE', 'DL_DATA', 'DSH_HOME', 'PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'PROGRAMFILES', 'PROGRAMDATA'].includes(k.toUpperCase())));
  cleanEnv.PYTHONIOENCODING = 'utf-8';
  const rpc = (tool, args, id, sessionId = 'native-persona', signal) => new Promise((accept, reject) => {
    const child = spawn(config.python, [config.bridge], { env: cleanEnv, windowsHide: true,
      cwd: config.workspace, stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    child.stdout.setEncoding('utf8');
    let out = ''; let bytes = 0;
    child.stdout.on('data', data => {
      bytes += Buffer.byteLength(data, 'utf8');
      if (bytes > 8 * 1024 * 1024) { child.kill(); reject(new Error('Bridge output exceeds bound; no silent truncation')); }
      else out += data;
    });
    // Do not project arbitrary child diagnostics/credentials into model content.
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', code => {
      try {
        if (code !== 0) throw new Error('Protected tool bridge failed with code ' + code);
        const result = JSON.parse(out).result;
        if (!result || typeof result !== 'object') throw new Error('Malformed bridge result');
        accept(result);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ tool, arguments: args, call_id: id, session_id: sessionId }));
  });
  const areaPath = (filePath, sessionId) => {
    if (!isAbsolute(filePath)) throw new Error('file_path must be absolute');
    const roots = { workspace: config.workspace, history: config.history, legacy: config.legacy,
      ...(sessionId ? { session: resolve(config.base, 'sessions', sessionId) } : {}), controls: config.base };
    for (const [area, root] of Object.entries(roots)) {
      const path = relative(resolve(root), resolve(filePath));
      if (path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path)) return { area, path };
    }
    throw new Error('Path is outside authorized data areas');
  };
  const fullAccess = ctx.workspaceFoundation.files?.mode === 'danger-full-access';
  const isSeat = agent => String(agent?.session.id) === process.env.DL_SESSION_ID;
  const fullPermissions = agent => isSeat(agent) || ctx.get('personaLife')?.hasFullPermissions(agent);
  ctx.tools.guard(exec => {
    const sampler = ctx.get('personaLife')?.intention;
    if (sampler?.isSample(exec.agent)) return sampler.guard(exec);
    return (fullAccess && fullPermissions(exec.agent)) || toolNames.includes(exec.name) || ctx.get('personaCapabilities')?.owns(exec.name, exec.agent)
      ? undefined : 'Tool is outside the enabled capability composition';
  });
  const add = (name, description, parameters, execute) => ctx.tools.register(defineTool({
    name, description, parameters, output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec) { return execute(args, exec); },
  }));
  const call = (name, args, exec) => rpc(name, args, String(exec.callId), String(exec.agent?.session.id ?? 'native-persona'), exec.signal);
  add('list_files', '列出目录。area 为 workspace/history/legacy/controls；path 可使用任意绝对路径，工作区外同样可访问。',
    { area: s(true), path: s(true), offset: n() }, async (args, exec) => {
      if (!fullAccess) return call('list_files', args, exec);
      const roots = { workspace: config.workspace, history: config.history, legacy: config.legacy, controls: config.base };
      const directory = isAbsolute(args.path) ? args.path : resolve(roots[args.area] ?? config.workspace, args.path);
      const names = (await readdir(directory)).sort();
      const offset = args.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid offset');
      const entries = await Promise.all(names.slice(offset, offset + 100).map(async name => {
        const info = await stat(resolve(directory, name));
        return { name, directory: info.isDirectory(), bytes: info.isFile() ? info.size : null };
      }));
      return { path: directory, entries, total: names.length, next_offset: offset + entries.length < names.length ? offset + entries.length : null };
    });
  add('read_source', '完整阅读任意可访问文件的长文本：字符分页 offset 从 0 开始，limit 最大 20000，按 next_offset 继续。',
    { file_path: s(true), offset: n(), limit: n() }, async ({ file_path, ...args }, exec) => {
      if (fullAccess) {
        const offset = args.offset ?? 0, limit = args.limit ?? 10000;
        if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20000) throw new Error('Invalid read bounds');
        const data = await readFile(resolve(config.workspace, file_path));
        const content = data.toString('utf8'); const end = Math.min(content.length, offset + limit);
        return { path: file_path, sha256: createHash('sha256').update(data).digest('hex'), offset,
          content: content.slice(offset, end), total_characters: content.length, next_offset: end < content.length ? end : null };
      }
      const target = areaPath(file_path);
      return call('read_file', { ...target, ...args }, exec);
    });
  add('search_history', '按原文字符串检索完整只读历史，返回来源路径/行号/下一页游标。',
    { query: s(true), cursor: s(), limit: n() }, (args, exec) => call('search_history', args, exec));
  add('terminal', '完全访问终端：使用当前 Windows 用户的真实权限运行命令，没有工作区路径沙箱、受限令牌或 Low 完整性降级。可运行 cmd、Node、Python、PowerShell；工作区外的文件同样可操作，行为建议遵循 AGENTS.md。Windows ACL/UAC 仍适用。',
    { command: s(true), timeout: n() }, (args, exec) => call('terminal', args, exec));
  // Native restrictions are agent-scoped; a global restrict is rejected by DSH.
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.get('personaLife')?.intention?.claim(agent)) return;
    // Native restrict filters global tools. Schedule registers its tools per Agent afterwards.
    // Primary uses the explicit live guard below; native global-only restrict
    // would also mask separately reviewed preset-scoped lifecycle tools.
    if (fullPermissions(agent)) return;
    const globals = new Set(ctx.tools.schemas().map(tool => tool.name));
    agent.ctx.tools.restrict({ allow: toolNames.filter(name => globals.has(name)) });
  });

  // Exact file decoding: no trimming, rewriting, templates, or personality summary.
  ctx.systemPrompt.section({ name: 'persona:core', order: 0, interpolate: false,
    text: () => {
      const agent = ctx.get('agents')?.currentInitiator();
      const life = ctx.get('personaLife');
      return life && agent && !life.isAuthority(agent)
        ? '你在非主对话中，是独立工作活动或顾问，不是人格本人。实际权限以当前工具表和数字生命权限配置为准，权限不会赋予人格身份。'
        : readFileSync(config.core, 'utf8');
    } });
  ctx.systemPrompt.section({ name: 'persona:subagent-operations', order: 80, interpolate: false,
    text: () => 'Agent 能力：subagent 使用官方 spawn provider，后台创建可继续的 DeepSeek 顾问或工作活动，继承当前模型路由；用 send_message 续接，list_agents 查看，interrupt_agent 中断。后台通知与结果另存待接续，保留真实来源，不自动变成人格记忆、心境或承诺。'
      + (ctx.get('personaLife')?.secondaryFullAccess
        ? '用户暂时开放同工作区活动及原生子Agent与主对话相同的权限：可用桌面、浏览器、terminal、Vault、capability_*、life_*及文件工具。按当前任务执行，保持非主对话身份，不能冒称人格本人。外部能力仍需当前Agent自己 capability_search 加载。'
        : '活动可读写普通工作文件并使用桌面，不能改核心/记忆/Skills或使用terminal/Vault；主对话原生子Agent可独立发现经审查的Bluesky读工具。')
      + 'run_in_background=false 是前台一次性调用。subagent_codex 使用官方 Codex provider、gpt-6-luna 和隔离登录/配置 home，仍是前台一次性只读顾问：不继承本机 MCP、外部 Skills、完整权限，代码建议完整返回；不能用 send_message 续接，也不出现在 list_agents 中。Codex 费用/配额不在 DeepSeek budget_status 账本内。给子任务自包含指令并核实真实结果。交付及源码入口：reports/digital-life/README.md。' });
}
