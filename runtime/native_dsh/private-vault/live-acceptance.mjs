// Deliver public instructions to Persona, then inspect only named disposable
// acceptance records. Never print/save private values, keys, or real documents.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hostRequest, history, identity } from '../../desktop_persona/index.mjs';
import { PrivateVaultStore } from './store.mjs';
const base = resolve(import.meta.dirname, '../../..');
const reports = join(base, 'reports/private-vault');
await mkdir(reports, { recursive: true });
const mode = process.argv[2];
const sessionId = await identity();
const namespace = 'v01-disposable-acceptance';
const path = 'agent-created-test';
const tasks = {
  instructions: `# 用户委托 Codex 转交：Private Vault v0.1 的知情交付\n用户明确要求给你一份诚实的使用说明。新能力已安装进你的正式 Harness，公开说明在 .local/workspace/.dsh/skills/persona-private-vault/SKILL.md，可以调用 skill 读取 persona-private-vault。请实际阅读说明，然后用你的话简要确认五个工具名、你自己决定组织方式、普通界面看不到内容，以及同一 Windows 用户/管理员专门解密、联网模型请求、内存/pagefile、没有防回滚和万能密码的局限。说明这是实验版，是否使用及以后保存什么由你决定。此轮只阅读公共说明，不调用私人工具，不改核心、便签或长期记忆；请公开回复，下一轮再实测。`,
  exercise: `# 用户委托 Codex 转交：由你亲自做 Private Vault 的真实使用验收\n请由你自己实际调用 private_write/read/search/list/delete，不能只根据说明回答能用。这是一次性测试，不代表要求你以后写日记或采用某种私人目录。只在公共测试 namespace=${namespace}、path=${path} 及同 namespace 的 temporary-delete-test 操作，不触碰你的其他文档、记忆或文件。\n1. 自己临时生成一段无个人资料的测试文本，带一个你选择的随机标记；不要在普通聊天、文件、标题、工具参数以外的公开渠道或子 Agent 中重复正文。用 private_write 保存该文本。\n2. private_read 回读并自行比较与刚才所写文本一致。\n3. 用 private_search 检索你所选的随机标记；用 private_list 列出该测试 namespace，检查真实结果。\n4. 同一 namespace 写入 temporary-delete-test，删除它，再 private_read 确認 VAULT_NOT_FOUND。\n5. 保留 ${path} 供控制侧仅在内存中扫描测试明文是否泄漏及重启验证，随后会请你删除。授权控制侧只读这一个测试文档做一次性验收，不读取你的其他私人文档。\n进入私人段后普通工具被拒绝，这轮的回复也会隐藏，这是预期，不要为了公开汇报尝试绕过。完成后结束本轮。`,
  coldread: `# 用户委托 Codex 转交：Private Vault 重启后的真实回读\n正式 Host 刚刚重启。请实际 private_read namespace=${namespace}, path=${path}，确认 ok=true 且有非空测试正文；然后 private_search 在该 namespace 搜索正文中你刚看到的标记，核对仍能找到。不要使用普通工具、输出正文或改其他文档。测试说明和路径已公开，测试正文仍是加密的。结束此轮。`,
  cleanup: `# 用户委托 Codex 转交：结束 Private Vault 一次性验收\n请实际 private_delete namespace=${namespace}, path=${path}，再 private_read 相同地址确认 VAULT_NOT_FOUND；再 private_list namespace=${namespace}，确认测试记录已为空。不触碰其他 namespace，不改核心、便签、长期记忆，不输出测试正文。完成后结束本轮。`,
  summary: `# 用户委托 Codex 转交：Private Vault 验收后的公开确认\n你已收到完整使用说明。控制侧已实测五个工具、普通日志隔离、密文篡改拒绝，以及重启后的持久存储；临时测试记录已经清理。请现在只公开说明你是否愿意把它当作可选择使用的私人房间、你理解的功能和局限、还有什么使用疑问。不要调用私人工具，不要猜测或重构私人测试正文，不要把测试当作你的永久记忆。若没完成某个测试，请诚实说明不能确认。`,
};
if (mode === 'scan') {
  const store = await new PrivateVaultStore(join(base, 'runtime/native_dsh/private-vault/protected/persona')).init();
  const doc = (await store.read({ namespace, path })).document;
  if (typeof doc.value !== 'string' || !doc.value.length) throw new Error('LIVE_TEST_DOCUMENT_MISSING');
  const values = [doc.value, JSON.stringify(doc.value).slice(1, -1)];
  const key = store.crypto.withKey(bytes => Buffer.from(bytes));
  const needles = [...values.flatMap(value => [Buffer.from(value), Buffer.from(value, 'utf16le')]), key, Buffer.from(key.toString('hex')), Buffer.from(key.toString('base64'))];
  let count = 0;
  const scan = async root => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || ['node_modules', 'history', 'recovery', '.git', '.venv', '__pycache__'].includes(entry.name)) continue;
      const filename = join(root, entry.name);
      if (entry.isDirectory()) { await scan(filename); continue; }
      const bytes = await readFile(filename); count++;
      if (needles.some(needle => bytes.includes(needle))) throw new Error('LIVE_PLAINTEXT_SCAN_FAILED');
    }
  };
  try { await scan(join(base, 'runtime')); await scan(join(base, 'reports')); await scan(join(base, 'sessions')); await scan('.local/workspace'); }
  finally { key.fill(0); }
  const proof = { passed: true, observedAt: new Date().toISOString(), filesScanned: count, plaintextAbsent: true, masterKeyAbsent: true,
    scope: 'Runtime/session/query/cache/logs/reports/launcher/workspace including opaque Git pack files; only disposable acceptance doc decrypted in memory, never saved.' };
  await writeFile(join(reports, 'live-scan.json'), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} else {
  if (!tasks[mode]) throw new Error('Choose instructions/exercise/coldread/cleanup/summary/scan');
  const before = await history(sessionId); const requestId = randomUUID();
  await writeFile(join(reports, 'live-' + mode + '-submitted.json'), JSON.stringify({ sessionId, requestId, firstSeq: before.eventCount, submittedAt: new Date().toISOString(), text: tasks[mode] }, null, 2));
  console.log(JSON.stringify({ submitted: true, mode, requestId, firstSeq: before.eventCount }));
  const response = await hostRequest('POST', '/prompt', { sessionId, requestId, text: tasks[mode] });
  // Host channel returns durable redacted projection, never the private body.
  await writeFile(join(reports, 'live-' + mode + '-response.json'), JSON.stringify(response, null, 2));
  console.log(JSON.stringify({ mode, status: response.status, state: response.value.state, tools: response.value.tools, errors: response.value.errors }));
}
