/** Native Cordis plugin template. Runs in the capability worker, without Host credentials. */
export const inject = ['tools'];
export async function apply(ctx) {
  ctx.tools.register({ name: 'hello', description: '无副作用的能力总线测试，返回固定问候。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object', properties: { greeting: { type: 'string' } }, required: ['greeting'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute() { return { greeting: 'Hello from Persona native Cordis capability' }; } });
}
