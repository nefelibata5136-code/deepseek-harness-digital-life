// Reviewed reference release. No fs, subprocess, network, env or model access.
import { native } from 'file:///./runtime/workspace_foundation/native.mjs';
export const name = 'persona-hello-world';
export const inject = ['tools'];
export async function apply(ctx) {
  const { defineTool } = await native('dsh-tools');
  ctx.tools.register(defineTool({
    name: 'persona_hello',
    description: '无副作用的插件入口测试；返回固定问候。',
    parameters: {},
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() { return { greeting: 'Hello from Persona plugin', side_effects: false }; },
  }));
}
