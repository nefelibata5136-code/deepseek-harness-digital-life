"""Produce B's local handoff report and suggested diff, never apply shared-file edits."""
from datetime import datetime
from zoneinfo import ZoneInfo
import difflib
import hashlib
import json
from pathlib import Path
import os

HERE = Path(__file__).resolve().parent
REPORTS = HERE.parents[1] / 'reports' / 'task_B'
WORKSPACE = Path(os.environ.get('DL_WORKSPACE', '.local/workspace'))

acceptance = json.loads((REPORTS / 'latest-acceptance.json').read_text('utf-8-sig'))
readonly = json.loads((REPORTS / 'read-only-check.json').read_text('utf-8-sig'))
assert acceptance['passed'] and acceptance['model_calls'] == 0
assert acceptance['aggregate_plugin']['loaded']
checks = acceptance['checks']
patch_path = REPORTS / 'AGENTS.suggested.patch'
suggested = patch_path.read_text('utf-8')
if '@@ 建议' in suggested:
    addition = '\n'.join(line[1:] for line in suggested.splitlines() if line.startswith('+') and not line.startswith('+++')) + '\n'
else:
    # Already a normal unified diff; keep its current proposed addition.
    addition = '\n'.join(line[1:] for line in suggested.splitlines() if line.startswith('+') and not line.startswith('+++')) + '\n'
agents = (WORKSPACE / 'AGENTS.md').read_text('utf-8-sig')
proposed = agents.rstrip('\n') + '\n' + addition
patch = ''.join(difflib.unified_diff(agents.splitlines(keepends=True), proposed.splitlines(keepends=True),
                                     fromfile='a/AGENTS.md', tofile='b/AGENTS.md'))
patch_path.write_text(patch, encoding='utf-8')
owned = [p for p in HERE.iterdir() if p.is_file()]
manifest = {'observed_at': datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
            'native_version': acceptance['native_version'], 'acceptance_root': acceptance['root'],
            'code_files': [{'path': str(p), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(owned)],
            'workspace_files': [{'path': str(p.relative_to(WORKSPACE)), 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
                                for p in sorted(WORKSPACE.rglob('*')) if p.is_file() and '.terminal-tmp' not in p.parts]}
(REPORTS / 'delivery-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
report = f'''# B 任务交付与验收

本地实现已完成，独立验收 {len(checks)} 项全部通过，模型调用 0 次。A 可直接加载的聚合 Cordis 入口也经过真实技术 Agent/Session turn 验证。正式启动器的接线由 A 完成，B 没有运行正式人格。

验收时间：{manifest['observed_at']}（Asia/Shanghai）。
实装官方 Harness：`{acceptance['native_version']}`；接口来自已安装包，不以旧 README 推断。官方项目来源：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。

## 可运行成果

- `runtime/workspace_foundation/snapshots.py`：独立受保护 Git 版本、启动恢复、turn token、查看/diff/指定文件/整版恢复。
- `lifecycle.mjs`：原生 turn/start、turn/end 和 awaited pre-step/tool 接线；异常失败阻断及退出健康检查。
- `files.mjs`：官方 fs-sandbox/tool-fs/observation-policy 加边界保护；未重造文件工具。
- `skills.mjs`：官方 skill registry + filesystem provider + skill 工具，两个精确工作区根，无后台 watcher。
- `extensions.mjs` / `hello-plugin.mjs` / `approved-plugins.json`：默认停用、固定批准 hash 的正规 Cordis 插件加载与撤销。
- `terminal_bridge.py`：复用现有 Windows 受限终端，workspace 来自控制侧，统一版本层承担快照。
- `plugin.mjs`：给 A 的聚合挂载入口；`check.mjs` 只读检查；`verify.mjs` 独立可复验入口。

真实工作区初始基线：`ed6a53328418b03ca2789d0a377fe341246a7a72`（原有 2 个文件）。
模板版本：`8231612150ec323fd36c09d580cf8db7a04fbc40`（7 个文件）。
控制程序和 history.git 放在 `runtime/workspace_foundation/protected/persona/` 所在保护边界，工作区无 `.git` 控制依赖。没有 remote/push、历史改写、后台任务或自动 reset/clean。

## 必要验收对应证据

| 要求 | 结果与实际操作 |
|---|---|
| 初始可恢复基线 | 真实工作区原有 core/map 按字节进入独立 Git；技术目录恢复和 fsck 通过 |
| 开始前已有变化、结束后本轮变化 | 原生 Agent 的两轮测试与聚合入口独立轮次均触发受保护 turn token；结束后 active=null、changes=[] |
| 文件工具修改 | 真实官方工具 registry.execute 调用 read/write/edit；先读规则和 stale 拒绝验证，未发模型请求 |
| 终端修改、新建、改名、删除 | 真实现有 Windows WRITE_RESTRICTED backend 经 terminal 测试注册调用，磁盘状态和 Git 版本均读回 |
| 异常中断后保留 | 子进程 begin 后写文件并 os._exit(23)；recover 在后续新动作前保存残留正文并关闭死进程标记 |
| 指定文件恢复、保留后续历史 | dry-run 不改文件；apply 先保护当前状态、追加新版本；先前后续 commit 仍可达 |
| 指定版本恢复 | 整版恢复新建/删除/改名状态；工作区整体被移除时显式重建恢复，空树对象 fsck 通过 |
| skill 更新 | 官方 provider 实际发现 hello；经官方 write 修改后再调用 skill 读取新正文；外部更新正文后的下一轮亦读取新正文 |
| plugin 加载与停用 | 官方 ctx.plugin 注册 persona_hello 返回固定问候；dispose 后注册消失、执行被拒；默认停用、改变候选 hash 拒载 |
| 保护位置 | 受限终端拒绝控制程序及实际 history.git/HEAD 的 r+ 可写句柄，新建保护区文件也被拒绝 |
| 只读检查 | check.mjs 两次完整检查，保护区 42 个文件的前后内容 hash 相同 |

测试原生 Session 仅为 `task-B-*` / `task-B-composition-*` 技术会话。模型 adapter 未安装；llm/stream 另有禁止调用断言。测试调用在 pre-step 验收回调中执行，真实原生 turn 按 blocked 结束；不把它冒充人格自主行动或付费模型驱动行为。正式 Session persistence 由 A 验证；本轮原生事件完整导出到证据文件。

## 证据和清理

当前成功证据：`{acceptance['root']}`。
该目录 `result.json`、`native-session-events.jsonl`、`tool-receipts.json`、版本 Git 存储都保留。
原生事件文件 SHA256：`{acceptance['session_events_sha256']}`。
技术工作区均清理；初期失败回合的残留工作区也按已核实绝对边界清理，旧 Git/证据仍保留，不作为本次成功证据。见 `cleanup.json`。
源码及实际工作区产物 hash 清单：`delivery-manifest.json`。只读检查证据：`read-only-check.json`、`read-only-check-repeat.json`、`read-only-inspector-validation.json`。

## 明确范围与限制

当前只确认 B 模块/技术 Session 流程可运行。自动机制尚须 A 接入正式 composition；必须完成 allow/restrict 白名单、原生 fs/provider 去重、Session resume、费用 admission/accounting 和退出健康检查的联合验收。接入说明：`INTEGRATION_FOR_A.md`；正式 AGENTS 建议是可审阅 unified diff `AGENTS.suggested.patch`，未应用。

排除凭据及疑似凭据正文、缓存/依赖/运行锁、数据库、链接/Junction、空目录和 ACL/时间戳/执行位；精确清单由 exclusions 命令提供。正文凭据筛查只有常见格式检测能力，应继续将真正凭据放在工作区之外。Git 不静默截断正常文件。没有写入磁盘的内容无法从崩溃中恢复；不支持并行顶层 writer，恢复前需停止 writer。文件/目录类型冲突明确拒绝覆盖。

插件是宿主代码，任意新插件不从工作区自动加载。示例只用固定已批准发布副本，A/用户审核新的宿主插件；技能内容不能扩大权限。旧受限终端不提供对所有个人文件的读取隔离。

B 没有修改 `persona-core.md`、正式 `AGENTS.md`、`persona-plugin.mjs`、模型配置或正式启动器，没有 vendor 内核修改、付费模型调用、正式人格启动、第一张迁移便签、后台任务或外部发布。此任务没有新建用户学习/生活记录应用，模板无用户活动副作用；统一导出器/dots 接入在以后新增记录应用时按已给出的规则登记并验证。
'''
(REPORTS / 'DELIVERY.md').write_text(report, encoding='utf-8')
print(json.dumps({'checks_passed': len(checks), 'report': str(REPORTS / 'DELIVERY.md'),
                  'shared_agents_patch_applied': False}, ensure_ascii=False, indent=2))
