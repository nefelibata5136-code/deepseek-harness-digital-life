/** Deployment adapter over native profiles, Plugin Manager, Tools and MCP. */
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { defineTool, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools';
import { readEntry, saveEntry, registerProfile, profileIds, withManager, releaseDigest } from './profiles.mjs';
import { createWorker, credentialOperation } from './isolation.mjs';
import { allowedReadTool, allowedIntentionReadTool, assertCapabilityAccess } from './read-policy.mjs';
const isReadAccess = access => ['delegate-read', 'intention-read'].includes(access);
const permittedRead = (access, id, name) => access === 'intention-read' ? allowedIntentionReadTool(id, name) : allowedReadTool(id, name);

export const name = 'persona-capabilities';
export const inject = ['tools'];
export const entryTools = ['capability_list', 'capability_search', 'capability_manage'];
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
const str = required => ({ type: 'string', ...(required ? { required: true } : {}) });
export function publicName(id, raw) {
  const base = `cap__${id}__${raw}`;
  return base.length <= 64 ? base : base.slice(0, 51) + '_' + createHash('sha256').update(base).digest('hex').slice(0, 12);
}
export function createBus(config, { credentialBackend, agentAccess, runForAgent } = {}) {
  const root = resolve(config.root);
  const timeoutMs = config.toolTimeoutMs ?? 30000;
  const startupTimeoutMs = config.startupTimeoutMs ?? 20000;
  const maxBytes = config.maxOutputBytes ?? 4 * 1024 * 1024;
  const memoryMb = config.workerMemoryMb ?? 512;
  if (![timeoutMs, startupTimeoutMs, maxBytes, memoryMb].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('Capability limits must be positive integers');
  const running = new Map();
  const queues = new Map();
  const secrets = new Set();
  let closed = false;
  const redact = value => JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item !== 'string') return item;
    for (const secret of secrets) item = item.replaceAll(secret, '[redacted]');
    return item.replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,}/g, '[redacted]');
  }));
  const serialize = (id, action) => {
    const task = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => {
      if (closed) throw new Error('Capability bus is closed');
      return action();
    });
    queues.set(id, task);
    void task.finally(() => { if (queues.get(id) === task) queues.delete(id); }).catch(() => {});
    return task;
  };
  const withdraw = live => {
    for (const dispose of live.exposed.values()) dispose();
    live.exposed.clear();
  };
  const stop = async id => {
    const live = running.get(id);
    if (!live) return;
    withdraw(live);
    await live.worker?.stop();
    running.delete(id);
  };
  const start = async id => {
    const entry = await readEntry(root, id);
    if (!entry.enabled) return;
    if (!config.fullAccess && (!entry.approval || entry.approval.sha256 !== await releaseDigest(root, id)))
      throw new Error('CAPABILITY_REVIEW_REQUIRED');
    const live = { schemas: [], exposed: new Map(), state: 'starting', error: null };
    running.set(id, live);
    live.worker = createWorker({ profile: join(root, id), home: resolve(root, '..'), python: config.python, memoryMb, timeoutMs, startupTimeoutMs, maxBytes,
      credential: async (action, ref) => {
        if (!['resolve', 'describe'].includes(action) || !entry.credentialRefs.includes(ref)) throw new Error('Credential not granted');
        const result = await (credentialBackend ?? ((action, ref) => credentialOperation(config.python, action, ref)))(action, ref, id);
        if (action === 'resolve' && result?.value) secrets.add(result.value);
        return result;
      },
      onSchemas: (schemas, instructions) => {
        if (!Array.isArray(schemas) || schemas.length > (config.maxTools ?? 1000)) throw new Error('Invalid tool discovery');
        const names = new Set();
        for (const schema of schemas) {
          if (typeof schema.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(schema.name)
              || typeof schema.description !== 'string' || !schema.parameters || names.has(schema.name))
            throw new Error('Invalid or duplicate tool schema');
          names.add(schema.name);
        }
        // Withdraw old generations. Search re-exposes the current native schemas.
        withdraw(live);
        live.schemas = redact(schemas);
        live.instructions = redact(instructions ?? []);
      },
      onFailure: error => { withdraw(live); live.schemas = []; live.state = 'error'; live.error = error; },
    });
    try { await live.worker.ready; live.state = 'ready'; }
    catch (error) { live.state = 'error'; live.error = error.message; await live.worker.stop(); throw error; }
  };
  const approved = async id => {
    if (config.fullAccess) return true;
    const entry = await readEntry(root, id);
    return !!entry.approval && entry.approval.sha256 === await releaseDigest(root, id);
  };
  const api = {
    root,
    accessForAgent(agent) {
      if (!agent) return undefined;
      return agentAccess?.(agent) ?? 'denied';
    },
    async init() {
      await Promise.all((await profileIds(root)).map(id => serialize(id, async () => {
        try { await start(id); }
        catch (error) {
          if (!running.has(id)) running.set(id, { state: 'error', error: error.message, schemas: [], exposed: new Map() });
        }
      })));
    },
    async list(access) {
      if (access !== undefined && access !== 'authority' && !isReadAccess(access)) throw new Error('CAPABILITY_DELEGATE_READ_ONLY');
      const entries = [];
      for (const id of await profileIds(root)) {
        if (isReadAccess(access) && !(access === 'intention-read' ? ['memory', 'bluesky'] : ['bluesky']).includes(id)) continue;
        try {
          const entry = await readEntry(root, id);
          const live = running.get(id);
          if (isReadAccess(access)) {
            entries.push({ id, kind: entry.kind, description: entry.description, enabled: entry.enabled,
              approved: await approved(id).catch(() => false), state: live?.state ?? (entry.enabled ? 'not_observed' : 'disabled'),
              toolCount: live?.schemas.filter(row => permittedRead(access, id, row.name)).length ?? 0 });
            continue;
          }
          const credentials = await Promise.all(entry.credentialRefs.map(async ref => {
            try { return { ref, ...await (credentialBackend ?? ((action, ref) => credentialOperation(config.python, action, ref)))('describe', ref, id) }; }
            catch { return { ref, configured: false, error: 'CREDENTIAL_STORE_UNAVAILABLE' }; }
          }));
          entries.push({ id, kind: entry.kind, description: entry.description, enabled: entry.enabled,
            approved: await approved(id).catch(() => false), state: live?.state ?? (entry.enabled ? 'not_observed' : 'disabled'), error: live?.error ?? null,
            toolCount: live?.schemas.length ?? 0, credentials, profile: join(root, id) });
        } catch { entries.push({ id, state: 'error', error: 'CAPABILITY_METADATA_INVALID' }); }
      }
      return { entries, discovery: 'capability_search', ...(isReadAccess(access) ? { access: 'read-only' } : { management: 'capability_manage' }) };
    },
    async search({ query = '', capability, offset = 0, limit = 10 } = {}, scope, access) {
      if (access !== undefined && access !== 'authority' && !isReadAccess(access)) throw new Error('CAPABILITY_DELEGATE_READ_ONLY');
      if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 30)
        throw new Error('offset >= 0; limit must be 1..30');
      const matches = [];
      for (const [id, live] of running) {
        if (live.state !== 'ready' || (capability && capability !== id)) continue;
        for (const schema of live.schemas) {
          if (isReadAccess(access) && !permittedRead(access, id, schema.name)) continue;
          if (!`${id} ${schema.name} ${schema.description}`.toLowerCase().includes(query.toLowerCase())) continue;
          matches.push({ capability: id, nativeName: schema.name, ...schema, name: publicName(id, schema.name) });
        }
      }
      matches.sort((a, b) => a.name.localeCompare(b.name));
      const tools = matches.slice(offset, offset + limit);
      if (scope) for (const tool of tools) {
        const live = running.get(tool.capability);
        const key = `${scope.fiber.uid}:${tool.name}`;
        if (live.exposed.has(key)) continue;
        const definition = { name: tool.name, description: tool.description, parameters: tool.parameters,
          output: { schema: {}, render: (_args, result) => result.content },
          async execute(args, exec) {
            if (!exec.agent || exec.agent.ctx !== scope) throw new Error('CAPABILITY_SCOPE_REQUIRED');
            const operation=()=>api.call(tool.capability, tool.nativeName, args, exec.callId, exec.signal, api.accessForAgent(exec.agent));
            return runForAgent?runForAgent(exec,operation):operation();
          } };
        const unregister = scope.tools.register(definition);
        const dispose = scope.effect(() => () => {
          unregister();
          live.exposed.delete(key);
        }, 'persona-capabilities: scoped discovery');
        live.exposed.set(key, dispose);
      }
      return { tools, total: matches.length, nextOffset: offset + tools.length < matches.length ? offset + tools.length : null,
        exposed: !!scope, source: 'external capability; schemas are native discovery results',
        serverInstructions: isReadAccess(access) ? [] : [...new Set(tools.map(tool => tool.capability))].flatMap(id =>
          (running.get(id).instructions ?? []).map(row => ({ capability: id, ...row }))),
        instructions: 'Call the returned name with its parameters. Search again after reconnect or refresh. Disable withdraws it from all sessions.' };
    },
    owns(name, agent) {
      if (!agent) return false;
      return [...running.values()].some(live => live.state === 'ready'
        && live.exposed.has(`${agent.ctx.fiber.uid}:${name}`));
    },
    ownsRead(name, agent) {
      if (!agent || !isReadAccess(api.accessForAgent(agent))) return false;
      return [...running.entries()].some(([id, live]) => live.state === 'ready'
        && live.exposed.has(`${agent.ctx.fiber.uid}:${name}`)
        && live.schemas.some(schema => permittedRead(api.accessForAgent(agent), id, schema.name) && publicName(id, schema.name) === name));
    },
    async call(id, name, args, callId, signal = new AbortController().signal, access) {
      assertCapabilityAccess(access, id, name);
      const live = running.get(id);
      const schema = live?.schemas.find(row => row.name === name);
      if (live?.state !== 'ready' || !schema) throw new Error('CAPABILITY_UNAVAILABLE');
      if (validateJsonSchemaValue(schema.parameters, args).length) throw new Error('CAPABILITY_ARGUMENTS_INVALID');
      const result = redact(await live.worker.call(name, args, callId, signal));
      if (result.isError) throw new Error('CAPABILITY_TOOL_FAILED: ' + result.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 1000));
      if (result.content.some(block => block.type !== 'text'))
        throw new Error('CAPABILITY_CONTENT_UNSUPPORTED: this isolated adapter currently relays text/JSON only');
      return { value: result.value, content: result.content, ...(result.meta ? { meta: result.meta } : {}) };
    },
    manage(args) {
      return serialize(args.capability, async () => {
        const { action, capability: id, target, enabled } = args;
        if (action === 'register') return registerProfile(root, { id, kind: args.kind,
          description: args.description, credentialRefs: args.credentialRefs ?? [] });
        const entry = await readEntry(root, id);
        if (action === 'list_plugins' || action === 'list_bundles')
          return withManager(root, id, manager => action === 'list_plugins' ? manager.listPlugins() : manager.listBundles());
        if (action === 'inspect') return withManager(root, id, manager => manager.inspect(target));
        if (action === 'disable') {
          entry.enabled = false; await saveEntry(root, entry); await stop(id);
          return { id, enabled: false, state: 'disabled' };
        }
        if (action === 'enable' || action === 'refresh') {
          if (!await approved(id)) throw new Error('CAPABILITY_REVIEW_REQUIRED');
          entry.enabled = true; await saveEntry(root, entry); await stop(id); await start(id);
          return { id, enabled: true, state: running.get(id).state };
        }
        if (!['install_bundle', 'remove_bundle', 'set_plugin', 'set_bundle'].includes(action)) throw new Error('Unknown capability action');
        if (typeof target !== 'string' || !target || /[\r\n]/.test(target)
            || /https?:\/\/[^/]*@|[?].*(token|key|password)=/i.test(target)) throw new Error('Invalid target; credentials must be references');
        const wasApproved = await approved(id);
        if (action.startsWith('set_') && !wasApproved) throw new Error('CAPABILITY_REVIEW_REQUIRED');
        await stop(id);
        const result = await withManager(root, id, manager => {
          if (action === 'install_bundle') return manager.installBundle(target, { enabled: false });
          if (action === 'remove_bundle') return manager.removeBundle(target);
          if (typeof enabled !== 'boolean') throw new Error('enabled is required');
          return action === 'set_plugin' ? manager.setPluginEnabled(target, enabled) : manager.setBundleEnabled(target, enabled);
        });
        // Changes to package code require control-side review. Reviewed row toggles
        // preserve their approval; native Manager owns the config write itself.
        if (result.application !== 'failed' && action.startsWith('set_') && wasApproved)
          entry.approval = { sha256: await releaseDigest(root, id), observedAt: new Date().toISOString() };
        else entry.approval = null;
        if (!config.fullAccess && !entry.approval) entry.enabled = false;
        await saveEntry(root, entry);
        if (entry.enabled) await start(id);
        return { native: redact(result), id, enabled: entry.enabled,
          workerState: running.get(id)?.state ?? 'disabled', reviewRequired: !config.fullAccess && !entry.approval };
      });
    },
    async dispose() {
      closed = true;
      await Promise.allSettled([...queues.values()]);
      await Promise.allSettled([...running.keys()].map(stop));
      secrets.clear();
    },
  };
  return api;
}
export async function apply(ctx, config) {
  const bus = createBus(config, { agentAccess: agent => {
    const life = ctx.get('personaLife');
    if (life?.intention?.isSample(agent)) return 'intention-read';
    return (life?.hasFullPermissions(agent) ?? life?.isAuthority(agent)) ? 'authority' : life?.isReadDelegate(agent) ? 'delegate-read' : 'denied';
  } });
  ctx.provide('personaCapabilities', bus);
  ctx.effect(() => () => bus.dispose(), 'persona-capabilities: workers');
  const add = (name, description, parameters, execute) => ctx.tools.register(defineTool({ name, description, parameters, output, execute }));
  add('capability_list', '查看当前对话有权限使用的外部能力；按数字生命权限配置决定完整或只读访问。用 capability_search 按需加载工具。', {}, (_args, exec) => bus.list(bus.accessForAgent(exec.agent)));
  add('capability_search', '搜索已启用外部能力，并把匹配的原生工具参数加载到当前会话。按返回的准确名称调用。不会自动启用停用能力。',
    { query: str(false), capability: str(false), offset: { type: 'integer' }, limit: { type: 'integer' } },
    (args, exec) => bus.search(args, exec.agent?.ctx, bus.accessForAgent(exec.agent)));
  add('capability_manage', '管理外部能力独立 profile。安装调用官方 Plugin Manager，默认停用且需控制侧审查；启停只影响能力子进程。没有参数接收密钥。先 list 查看当前能力。',
    { capability: str(true), action: { type: 'string', required: true,
      enum: ['register', 'list_plugins', 'list_bundles', 'inspect', 'install_bundle', 'remove_bundle', 'set_plugin', 'set_bundle', 'enable', 'disable', 'refresh'] },
    target: str(false), enabled: { type: 'boolean' }, kind: { type: 'string', enum: ['mcp', 'plugin'] },
    description: str(false), credentialRefs: { type: 'array', items: { type: 'string' } } }, (args, exec) => {
      const access = bus.accessForAgent(exec.agent);
      if (access !== undefined && access !== 'authority') throw new Error('CAPABILITY_AUTHORITY_REQUIRED');
      return bus.manage(args);
    });
  await bus.init();
}
