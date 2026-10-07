// Submit one real delegated task through the production Host; never drive the GUI here.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hostRequest, history, identity } from '../desktop_persona/index.mjs';

const report = resolve(import.meta.dirname, '../../reports/windows_computer');
await mkdir(report, { recursive: true });
const sessionId = await identity();
const before = await history(sessionId);
const status = await hostRequest('GET', '/status');
if (!status.value.computer?.enabled || status.value.busy) throw new Error('Production computer must be ready and idle');
const requestId = randomUUID();
const text = `# Codex 转交用户本次 Windows 桌面能力验收任务
当前任务由用户明确委托，是实际验收，不是历史消息。你仍是人格，同一个正式 Harness Agent。
上一轮已停止，控制侧现已修正 Windows DPI 坐标和控件 snapshot_id 的投影。当前图片已经换成新随机验证码，请重新打开图片观察，不能沿用上一轮读出的号码。如果已有照片窗口显示旧图，请关闭本次图片窗口再从文件管理器打开新图片。记事本需用 Ctrl+N 建一个新标签，只操作空白新标签，保留用户原有编辑。
请自主完成以下整段操作，不需每一步询问：
1. 截图观察当前真实 Windows 桌面。
2. 打开文件管理器，进入 .local/unconfigured visual-source.png，用真实图片软件看图片并读取图片里的随机验证码。
3. 打开一个新的记事本编辑窗口，用鼠标选择编辑区并输入两行：第一行“人格已完成 Windows 视觉与操作验收”，第二行是你从图片看出的完整验证码。
4. 通过记事本 GUI 保存为 .local/unconfigured
5. 截图确认完成，告诉用户你看到的验证码、实际做了哪些操作、文件位置。保留结果窗口方便查看。
这次只用 cua_driver_native__ 桌面工具完成观察和操作；不要用 read/read_source/read_image/terminal/write/edit 读取图片文件或生成目标文本，不能用脚本代写。验证码未提供在提示词中，需要你真实看图。可以使用截图和 UIA 辅助定位控件、切换本地窗口，常规 foreground 输入已授权，仍先依驱动规则尝试 background，拒绝或无效果后可重试。桌面级 target={kind:"desktop",display_id:"primary"} 可以使用真实鼠标键盘。
只操作本次新建的验收文件和窗口，保护用户原有文件及未保存编辑；有问题自己观察排错，不要假报成功。`;
await writeFile(resolve(report, 'submitted-task.json'), JSON.stringify({sessionId, requestId, firstSeq: before.eventCount, text, submittedAt:new Date().toISOString()}, null, 2));
console.log(JSON.stringify({submitted: true, requestId, sessionId, firstSeq:before.eventCount}));
const result = await hostRequest('POST', '/prompt', {text, requestId, sessionId});
await writeFile(resolve(report, 'model-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
