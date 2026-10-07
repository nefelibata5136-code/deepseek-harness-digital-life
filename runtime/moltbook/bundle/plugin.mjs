import { MoltbookClient } from './client.mjs';
import { availableTools } from './tools.mjs';
import { readApproved } from './approvals.mjs';
export const inject = ['tools', 'credentials'];
export function apply(ctx, config, testDependencies = {}) {
  const client = new MoltbookClient({ credentials: ctx.credentials, config,
    ...testDependencies,
    approvalCheck: async args => readApproved(args, config.stateRoot,
      (await ctx.credentials.resolve(config.credentialRef))?.value) });
  ctx.effect(() => () => client.close(), 'moltbook transport and per-life ledger');
  for (const tool of availableTools(config)) ctx.tools.register({
    name: 'moltbook_' + tool.name,
    description: tool.description,
    parameters: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, exec = {}) {
      const value = await client.invoke(tool.name, args, exec.signal);
      return JSON.parse(JSON.stringify(value));
    },
  });
}
