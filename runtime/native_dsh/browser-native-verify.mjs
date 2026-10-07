// Native Harness tool and durable-image acceptance, without any model HTTP call.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { bootNative, here } from './boot-native.mjs';
const base = resolve(here, '../..');
const run = resolve(base, 'reports/task_A/browser-native-' + randomUUID());
const cwd = resolve(run, 'workspace');
await mkdir(cwd, { recursive: true });
await writeFile(resolve(cwd,'persona-core.md'), await readFile('.local/workspace/persona-core.md'));
delete process.env.DEEPSEEK_API_KEY;
const sessionId = SessionId(randomUUID());
let ctx;
try {
  ctx = await bootNative({ sessionId, testRoot: run });
  await ctx.plugin(McpClient, {serverName:'persona_browser',transport:'stdio',
    command:resolve(here,'../browser/.venv/Scripts/python.exe'),args:['-X','utf8',resolve(here,'../browser/server.py')],
    env:{LOCALAPPDATA:'.local/unconfigured/Local',APPDATA:'.local/unconfigured/Roaming',USERPROFILE:'.local/unconfigured/maintainer'},
    failOnStartupError:true});
  await ctx.sessionController.create({sessionId,cwd});
  const resolved = await ctx.sessionController.resolveAgent(sessionId);
  if ('error' in resolved) throw resolved.error;
  const agent = resolved.agent;
  const names = agent.ctx.tools.schemas().map(t=>t.name);
  if (!names.includes('mcp__persona_browser__browser_screenshot')) throw new Error('Browser tool excluded from Persona Agent scope');
  const execute = async (raw, args={}) => {
    const result = await agent.ctx.tools.execute({agent,callId:ToolCallId(randomUUID()),
      name:'mcp__persona_browser__'+raw,arguments:args,signal:new AbortController().signal});
    if(result.isError)throw new Error(JSON.stringify(result.content));
    return result;
  };
  const before = await execute('browser_status');
  await execute('browser_navigate',{url:'https://www.xiaohongshu.com/explore',new_tab:true});
  const page = await execute('browser_read_page',{limit:500});
  if(JSON.stringify(page.content).includes('human_required\\\": true')) throw new Error('Human verification required');
  const image = await execute('browser_screenshot');
  const block = image.content.find(b=>b.type==='image');
  if(!block?.attachment)throw new Error('Native MCP screenshot was not admitted as an image');
  const stored = await ctx.attachments.readImage(block.attachment);
  const info = await ctx.llm.resolveModelInfo('deepseek-official','deepseek-flash');
  if(!info.inputModalities?.includes('image'))throw new Error('Selected Flash route lacks image input');
  const report={model_called:false,agent_scope_has_browser:true,native_mcp_execute:true,
    screenshot_native_image:true,image_bytes:stored.data.length,attachment:block.attachment,
    flash_declares_image_input:true,status:before.content,page_text_received:true,test_root:run};
  await mkdir(resolve(base,'reports/browser'),{recursive:true});
  await writeFile(resolve(base,'reports/browser/native-image.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({...report,attachment:{mediaType:block.attachment.mediaType}},null,2));
}finally{if(ctx)await ctx.fiber.dispose();}
