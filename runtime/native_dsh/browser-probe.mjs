// Control-side MCP probe. Text/metadata only; image bytes go to a private file.
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { here } from './boot-native.mjs';
const instructions = process.argv[2] ? JSON.parse(await readFile(process.argv[2], 'utf8')) : [];
const client = new Client({ name: 'persona-browser-acceptance', version: '1' });
const transport = new StdioClientTransport({ command: resolve(here, '../browser/.venv/Scripts/python.exe'),
  args: ['-X', 'utf8', resolve(here, '../browser/server.py')], stderr: 'pipe',
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH','SYSTEMROOT','WINDIR','LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP'].includes(k.toUpperCase()))) });
transport.stderr?.resume();
try {
  await client.connect(transport);
  const list = await client.listTools();
  console.log(JSON.stringify({ tools: list.tools.map(t => t.name) }));
  for (const { name, arguments: args = {}, imagePath } of instructions) {
    const result = await client.callTool({ name, arguments: args });
    for (const block of result.content ?? []) {
      if (block.type === 'image' && imagePath) await writeFile(imagePath, Buffer.from(block.data, 'base64'));
    }
    const projected = { name, error: result.isError ?? false, content: result.content.map(b => b.type === 'image' ? { type: 'image', mimeType: b.mimeType, bytes: Buffer.byteLength(b.data,'base64') } : b) };
    if (process.env.TASK_BROWSER_PROBE_OUTPUT) await writeFile(process.env.TASK_BROWSER_PROBE_OUTPUT, JSON.stringify(projected, null, 2));
    console.log(JSON.stringify(projected));
  }
} finally { await client.close(); }
