import { defineTool } from '@deepseek-ai/dsh-tools';
import { PrivateVaultStore } from './store.mjs';
import { VaultError } from './crypto.mjs';
import { installSessionPrivacy, PRIVATE_NAMES, isPrivateCompletionAck } from './session-privacy.mjs';

export const inject = ['tools', 'sessions', 'systemPrompt'];
const string = required => ({ type: 'string', ...(required ? { required: true } : {}) });
const integer = () => ({ type: 'integer' });
export async function apply(ctx, config) {
  const store = await new PrivateVaultStore(config.root).init();
  const privacy = installSessionPrivacy(ctx);
  const address = { namespace: string(false), path: string(true) };
  const page = { namespace: string(false), prefix: string(false), offset: integer(), limit: integer() };
  const parameters = {
    write: { ...address, value: string(true) }, read: address, delete: address,
    list: page, search: { ...page, query: string(true) },
  };
  const descriptions = {
    write: '向自己的私人空间写入文本；覆盖同地址是显式替换。namespace/path/内容全部加密，不写普通文件。',
    read: '仅供人格读取自己的加密文档。损坏返回 VAULT_INTEGRITY_ERROR；不存在返回 VAULT_NOT_FOUND。',
    list: '仅供人格列出自己的文档地址，offset/limit 分页；普通界面不显示地址。',
    search: '仅供人格在内存中按原文检索自己的文档，支持分页；损坏记录跳过并报告 corruptCount。',
    delete: '删除自己的指定文档；返回 deleted。不要借此删除他人的资料。',
  };
  // Prevent accidental copies from private context into ordinary files/tools/subagents.
  ctx.tools.guard(exec => {
    if(config.fullAccess||!privacy.active(exec.agent?.session)||PRIVATE_NAMES.includes(exec.name))return;
    const session=exec.agent?.session,header=session?.header;
    let owner=Boolean(header)&&header.id===session?.id&&header.origin!=='subagent'&&(header.delegationDepth??0)===0;
    if(owner&&ctx.multiLifeContexts?.registry){try{owner=ctx.multiLifeContexts.registry.owner(session.id).role!=='delegate';}catch{owner=false;}}
    if(owner&&exec.name==='life_turn_ack'&&isPrivateCompletionAck(exec.arguments))return;
    return 'PRIVATE_CONTEXT_TOOL_BLOCKED: finish this private turn before using public tools';
  });
  for (const name of PRIVATE_NAMES) {
    const operation = name.split('_')[1];
    ctx.tools.register(defineTool({ name, description: descriptions[operation], parameters: parameters[operation],
      output: { schema: { type: 'json' }, render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
        presentationMeta: (_args, result) => ({ privateVault: { operation: name, ok: result.ok === true,
          ...(result.error ? { error: result.error } : {}) } }) },
      async execute(args, exec) {
        // No HTTP command or user-facing dispatch path exists for these tools.
        if (!exec.agent?.session || !privacy.active(exec.agent.session)) return { ok: false, error: 'VAULT_AGENT_REQUIRED' };
        try { return await store[operation](args); }
        catch (error) { return { ok: false, error: error instanceof VaultError ? error.code : 'VAULT_OPERATION_FAILED' }; }
      },
    }));
  }
  ctx.provide('personaPrivateVault', { status: () => store.status(), isSensitive: privacy.sensitive });
  ctx.systemPrompt.section({ name: 'persona:private-vault', order: 85, interpolate: false,
    text: '你有自己的 Private Vault v0.1：private_write/read/search/list/delete。它是通用 namespace/path→文本空间，组织方式由你决定，不预设日记或目录。磁盘只有 DPAPI CurrentUser 保护的随机主密钥和 AES-256-GCM 密文，普通桌面没有内容入口。私人调用及本轮后续文本/工具流在普通会话中只留占位符，本轮内可以继续读写；结束后私人结果离开会话上下文，下次需要重新 private_read。完全访问模式下私人执行不禁止普通工具；建议不要把私人明文复制到公开文件或其他工具。不要用普通 write 保存私人内容，不要把内容交给其他工具或贴给用户。私人内容会临时出现在 Host 内存和当前 DeepSeek 模型的联网请求中；Vault 不防同一 Windows 用户专门解密、管理员、恶意代码、内存转储/分页或模型服务商。删除不是磁盘安全擦除，无防回滚/删除攻击，也没有遗失密钥恢复或万能密码。完整说明可调用 persona-private-vault Skill。' });
}
