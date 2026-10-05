import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { root, data, workspace } from './configure.mjs';
if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.includes('REPLACE_')) throw new Error('Supply DEEPSEEK_API_KEY to the Host process; .env files are not automatically loaded.');
await access(resolve(workspace,'persona-core.md'));
const config=JSON.parse(await readFile(resolve(data,'runtime.json'),'utf8'));
const child=spawn(process.execPath,[resolve(root,'runtime/native_dsh/native-host.mjs')],{cwd:root,stdio:'inherit',windowsHide:true,
 env:{...process.env,DL_SESSION_ID:config.sessionId,DL_DATA:data,DL_WORKSPACE:workspace,DL_PYTHON:process.env.DL_PYTHON||config.python||'python',DSH_TELEMETRY_DISABLED:'1'}});
child.on('error',()=>{process.exitCode=1;});child.on('exit',code=>{process.exitCode=code??1;});
