/** Native keyless integration and failure-isolation checks in new temporary profiles. */
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, cp, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { stringify } from 'yaml';
import { createBus } from './bus.mjs';
import { registerProfile, approveProfile, withManager, readEntry, saveEntry } from './profiles.mjs';
import { credentialOperation } from './isolation.mjs';
import { bootNative } from '../boot-native.mjs';
import { assertCredentialSafeConfig } from './mcp-ref.mjs';

const base = resolve(import.meta.dirname, '../../..');
const sourcePaths = [...(await readdir(import.meta.dirname)).filter(name => /\.(mjs|py)$/.test(name)).map(name => resolve(import.meta.dirname, name)),
  ...['boot-native.mjs', 'native-host.mjs', 'persona-plugin.mjs', 'home/profiles/persona/cordis.patch.yml'].map(name => resolve(import.meta.dirname, '..', name))];
const hashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path.slice(base.length + 1).replaceAll('\\', '/'), createHash('sha256').update(await readFile(path)).digest('hex')])));
const sourceSha256 = await hashes();
const root = resolve(base, 'reports/capabilities/acceptance-' + randomUUID());
const profiles = join(root, 'capability-profiles');
const python = (process.env.DL_PYTHON || 'python');
const ref = 'DL_TEST_' + randomBytes(12).toString('hex').toUpperCase();
const secret = 'synthetic-' + randomBytes(24).toString('hex');
const corePath = '.local/workspace/persona-core.md';
const core = await readFile(corePath);
await mkdir(join(root, 'workspace'), { recursive: true });
await writeFile(join(root, 'workspace/persona-core.md'), core);
await writeFile(join(root, 'workspace/AGENTS.md'), '# Offline capability fixture only\n');
process.env.DEEPSEEK_API_KEY = 'offline-placeholder-not-a-secret';
let bus; let host; let httpServer; let credentialCreated = false;
const checks = [];
const check = (name, test) => { assert(test, name); checks.push(name); };
const install = async (id, kind, bundlePath, refs = []) => {
  await registerProfile(profiles, { id, kind, description: 'Offline capability ' + id, credentialRefs: refs });
  const result = await withManager(profiles, id, manager => manager.installBundle(bundlePath, { enabled: false }));
  assert.notEqual(result.application, 'failed', JSON.stringify(result));
  await assert.rejects(bus.manage({ capability: id, action: 'enable' }), /REVIEW_REQUIRED/);
  await withManager(profiles, id, manager => manager.setBundleEnabled(result.bundle, true));
  await approveProfile(profiles, id);
  await bus.manage({ capability: id, action: 'enable' });
};
try {
  for (const url of ['https://name:secret@example.invalid/mcp', 'https://example.invalid/mcp?access_token=secret',
    'https://example.invalid/mcp?api_key=secret', 'https://example.invalid/mcp#token=secret'])
    assert.throws(() => assertCredentialSafeConfig({ url }), /credential references/);
  assertCredentialSafeConfig({ url: 'https://example.invalid/mcp?workspace=demo', headerRefs: { Authorization: ref } });
  checks.push('MCP transport rejects inline URL credentials before connection');
  const stored = await credentialOperation(python, 'set', ref, secret); credentialCreated = true;
  check('Windows credential stored with metadata-only receipt', stored.configured && !JSON.stringify(stored).includes(secret));
  assert.equal((await credentialOperation(python, 'resolve', ref)).value, secret);
  bus = createBus({ root: profiles, python, startupTimeoutMs: 5000, toolTimeoutMs: 1200, maxOutputBytes: 1024 * 1024 });
  const helloPath = join(root, 'hello-bundle');
  await cp(resolve(import.meta.dirname, 'examples/hello'), helloPath, { recursive: true });
  await install('hello', 'plugin', helloPath);
  const hello = await bus.call('hello', 'hello', {}, 'hello-offline');
  check('Official Plugin Manager installs and enables native Cordis bundle', hello.value.greeting.includes('native Cordis'));
  const mcpPath = join(root, 'mcp-bundle');
  await mkdir(mcpPath);
  await writeFile(join(mcpPath, 'package.json'), JSON.stringify({ name: 'persona-test-mcp', version: '1.0.0', private: true,
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(mcpPath, 'cordis.patch.yml'), stringify([{ insert: [{ id: 'native-mcp',
    name: resolve(import.meta.dirname, 'mcp-ref.mjs'), config: { transport: 'stdio', serverName: 'fixture',
      command: process.execPath, args: [resolve(import.meta.dirname, 'fixture-mcp.mjs')],
      envRefs: { TEST_TOKEN: ref }, toolCallTimeoutMs: 1000, reconnect: { enabled: false } } }] }]));
  await install('mcp', 'mcp', mcpPath, [ref]);
  const mcp = await bus.call('mcp', 'mcp__fixture__echo', { text: 'hello' }, 'mcp-offline');
  check('Native MCP discovers and executes stdio tool', mcp.value.structuredContent.received === 'hello');
  check('MCP subprocess does not inherit main provider credential', mcp.value.structuredContent.parentKeyPresent === false);
  check('Resolved capability credential redacted from tool result', mcp.content[0].text.includes('[redacted]') && !JSON.stringify(mcp).includes(secret));
  const metadata = await bus.list();
  check('Capability list exposes credential status without value', metadata.entries.find(row => row.id === 'mcp').credentials[0].configured && !JSON.stringify(metadata).includes(secret));
  const discovery = await bus.search({ capability: 'mcp', limit: 30 });
  check('Native resource tools are discoverable', discovery.tools.some(tool => tool.nativeName === 'read_mcp_resource'));
  check('Server instructions only returned on explicit discovery', discovery.serverInstructions[0].text.includes('Offline fixture'));
  const resource = await bus.call('mcp', 'read_mcp_resource', { server: 'fixture', uri: 'fixture://hello' }, 'resource-offline');
  check('Native resource read works through isolated adapter', JSON.stringify(resource).includes('offline resource content'));
  let httpAuthorized = false;
  httpServer = createServer(async (request, response) => {
    if (request.method !== 'POST') { response.writeHead(405); return response.end(); }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (input.id === undefined) { response.writeHead(202); return response.end(); }
    httpAuthorized = request.headers.authorization === 'Bearer ' + secret;
    const result = input.method === 'initialize'
      ? { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline-http', version: '1.0.0' } }
      : input.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'Offline HTTP ping', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'HTTP ping' }], structuredContent: { authorized: httpAuthorized } };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }));
  });
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  const httpPath = join(root, 'http-bundle');
  await mkdir(httpPath);
  await writeFile(join(httpPath, 'package.json'), JSON.stringify({ name: 'persona-test-http', version: '1.0.0', private: true,
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(httpPath, 'cordis.patch.yml'), stringify([{ insert: [{ id: 'native-http', name: resolve(import.meta.dirname, 'mcp-ref.mjs'),
    config: { transport: 'streamable-http', serverName: 'httpfixture', url: 'http://127.0.0.1:' + httpServer.address().port,
      headerRefs: { Authorization: { ref, prefix: 'Bearer ' } }, reconnect: { enabled: false } } }] }]));
  await install('http', 'mcp', httpPath, [ref]);
  check('Native Streamable HTTP MCP uses a secure header reference',
    (await bus.call('http', 'mcp__httpfixture__ping', {}, 'http-offline')).value.structuredContent.authorized);
  await bus.manage({ capability: 'http', action: 'disable' });
  await assert.rejects(bus.call('mcp', 'mcp__fixture__echo', {}, 'invalid-offline'), /ARGUMENTS_INVALID/);
  checks.push('Native schema rejects invalid tool arguments');
  await bus.manage({ capability: 'mcp', action: 'disable' });
  await assert.rejects(bus.call('mcp', 'mcp__fixture__echo', { text: 'disabled' }, 'disabled-offline'), /UNAVAILABLE/);
  check('Disable withdraws tools immediately', (await bus.search({ capability: 'mcp' })).total === 0);
  await bus.manage({ capability: 'mcp', action: 'enable' });

  const failuresPath = join(root, 'failure-bundle');
  await mkdir(failuresPath);
  await writeFile(join(failuresPath, 'package.json'), JSON.stringify({ name: 'persona-test-failures', version: '1.0.0', type: 'module', private: true,
    dsh: { bundle: { patch: './cordis.patch.yml' } } }));
  await writeFile(join(failuresPath, 'cordis.patch.yml'), '- insert:\n    - id: failures\n      name: ./plugin.mjs\n');
  await writeFile(join(failuresPath, 'plugin.mjs'), `import {spawn} from 'node:child_process'; export const inject=['tools']; export async function apply(ctx){
    for(const name of ['crash','spin','throw','huge','descendant'])ctx.tools.register({name,description:'offline failure '+name,
      parameters:{type:'object',properties:{}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
      async execute(){if(name==='descendant'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});child.unref();return String(child.pid)}if(name==='crash')process.exit(7);if(name==='spin')while(true){};if(name==='throw')throw new Error('offline tool failure');return 'x'.repeat(2*1024*1024)}})}\n`);
  await install('failures', 'plugin', failuresPath);
  await assert.rejects(bus.call('failures', 'throw', {}, 'throw-offline'), /TOOL_FAILED/);
  check('Thrown tool error leaves worker healthy', (await bus.list()).entries.find(row => row.id === 'failures').state === 'ready');
  const descendantPid = Number((await bus.call('failures', 'descendant', {}, 'descendant-offline')).value);
  await assert.rejects(bus.call('failures', 'crash', {}, 'crash-offline'), /PROCESS_EXITED/);
  assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  checks.push('Windows Job reclaims descendants after abrupt worker exit');
  check('Crashed plugin does not affect another capability', (await bus.call('hello', 'hello', {}, 'healthy-offline')).value.greeting.includes('Hello'));
  await bus.manage({ capability: 'failures', action: 'refresh' });
  const started = Date.now();
  await assert.rejects(bus.call('failures', 'spin', {}, 'timeout-offline'), /CALL_TIMEOUT/);
  check('Noncooperative plugin terminated within timeout bound', Date.now() - started < 5000);
  await bus.manage({ capability: 'failures', action: 'refresh' });
  await assert.rejects(bus.call('failures', 'huge', {}, 'huge-offline'), /OUTPUT_LIMIT/);
  checks.push('Oversized output fails explicitly and withdraws capability');
  await bus.manage({ capability: 'failures', action: 'disable' });
  const installed = join(profiles, 'hello/node_modules/persona-capability-hello/plugin.mjs');
  const original = await readFile(installed);
  await writeFile(installed, Buffer.concat([original, Buffer.from('// altered fixture\n')]));
  await assert.rejects(bus.manage({ capability: 'hello', action: 'refresh' }), /REVIEW_REQUIRED/);
  checks.push('Package byte changes invalidate control-side approval');
  await writeFile(installed, original);
  await bus.dispose(); bus = undefined;
  // Mount the actual native Harness into fresh Session/storage/version/budget roots.
  host = await bootNative({ sessionId: randomUUID(), testRoot: root });
  const sessionId = randomUUID();
  await host.sessionController.create({ sessionId, cwd: join(root, 'workspace') });
  const resolved = await host.sessionController.resolveAgent(sessionId);
  if ('error' in resolved) throw resolved.error;
  const agent = resolved.agent;
  const before = agent.ctx.tools.schemas(agent).map(row => row.name);
  const secondSession = randomUUID();
  await host.sessionController.create({ sessionId: secondSession, cwd: join(root, 'workspace') });
  const second = await host.sessionController.resolveAgent(secondSession);
  if ('error' in second) throw second.error;
  check('Three management entry tools available in native Agent', ['capability_list', 'capability_search', 'capability_manage'].every(name => before.includes(name)));
  check('External tool schemas absent before explicit discovery', before.every(name => !name.startsWith('cap__')));
  const searchResult = await agent.ctx.tools.execute({ agent, name: 'capability_search', callId: 'native-search',
    arguments: { capability: 'hello', query: 'hello' }, signal: new AbortController().signal });
  assert.equal(searchResult.isError, false, JSON.stringify(searchResult));
  const found = searchResult.value.tools[0];
  check('Discovery adds scoped tool schema without changing global whitelist', agent.ctx.tools.schemas(agent).some(row => row.name === found.name));
  check('Discovery does not expose tools to another Agent', !second.agent.ctx.tools.schemas(second.agent).some(row => row.name === found.name));
  const secondSearch = await second.agent.ctx.tools.execute({ agent: second.agent, name: 'capability_search', callId: 'second-search',
    arguments: { capability: 'hello' }, signal: new AbortController().signal });
  check('A second Agent can independently discover the same tool', !secondSearch.isError
    && second.agent.ctx.tools.schemas(second.agent).some(row => row.name === found.name));
  await second.agent.ctx.fiber.dispose();
  check('Disposed Agent releases discovery ownership', !host.personaCapabilities.owns(found.name, second.agent)
    && host.personaCapabilities.owns(found.name, agent));
  const call = await agent.ctx.tools.execute({ agent, name: found.name, callId: 'native-hello', arguments: {}, signal: new AbortController().signal });
  check('Dynamic tool passes the actual Persona guard', call.isError === false && call.value.value.greeting.includes('Hello'));
  const assembled = await host.systemPrompt.assemble({ scope: agent });
  check('Core prompt preserved byte for byte', assembled.sections.find(section => section.name === 'persona:core').text === core.toString('utf8'));
  check('MCP instructions do not enter core prompt', assembled.sections.every(section => !section.name.startsWith('mcp:')));
  await host.personaCapabilities.manage({ capability: 'hello', action: 'disable' });
  check('Disable withdraws scoped schemas from existing Agent', !agent.ctx.tools.schemas(agent).some(row => row.name === found.name));
  await host.fiber.dispose(); host = undefined;
  assert.deepEqual(await hashes(), sourceSha256, 'Source changed during validation');
  const result = { passed: true, observedAt: new Date().toISOString(), nativeVersion: '0.2.0-rc.2',
    paidRequests: 0, modelRequests: 0, originalCoreChanged: false, testRoot: root, sourceSha256, sourceHashesUnchanged: true, checks };
  await writeFile(resolve(base, 'reports/capabilities/validation.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await host?.fiber.dispose(); await bus?.dispose();
  if (httpServer) await new Promise(resolve => httpServer.close(resolve));
  if (credentialCreated) {
    await credentialOperation(python, 'unset', ref);
    assert.equal((await credentialOperation(python, 'describe', ref)).configured, false);
  }
}
