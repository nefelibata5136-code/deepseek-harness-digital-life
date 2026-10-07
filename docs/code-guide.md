# 实现与维护入口

公开部署从 `scripts/setup-world.mjs`、`scripts/world.mjs`、`scripts/life-control.mjs` 进入；现代 worker 使用 `runtime/native_dsh/multi-life/supervisor/public-deployment.mjs` 读取本机 settings。历史部署的 `deployment.mjs`、`neutral.mjs`、`operate.mjs` 与 `live-*`/`accept-*`/`probe-*` 操作脚本保留为实现参考，不是公开包的默认启动入口；其中 `.local/unconfigured` 明确表示需要接线，不能直接运行它们作为安装步骤。

| 目录 | 责任与检查入口 |
|---|---|
| `runtime/native_dsh/multi-life` | contracts、Registry、trusted context、owner runtime、fixture；`registry.test.mjs` |
| `multi-life/life-services`、`private-services` | 本人状态、Core、clock、Memory/Vault；各自 `*.test.mjs` |
| `multi-life/platform` | native boot、Provider、工具归属、Rooms、任务、输入/行动真相、持久恢复；相关 `*.test.mjs` |
| `multi-life/recent-events` | store、固定批次、渲染、ACK、本人决定、worker、压缩兼容；各自 `*.test.mjs` |
| `multi-life/supervisor` | 中立 World、health、资源协调、现代 worker、测试 Session 与部署控制 |
| `runtime/native_dsh/subagent-router` | 默认模型、后台任务、父通知、slots、取消；`settings.json`、router/slots tests |
| `runtime/native_dsh/digital-life`、`recovery` | 状态、Resident、意向、压缩与恢复；source tests 与 `verify-self-compaction.mjs` |
| `runtime/deepseek_billing` | official cache、snapshots、producer、browser response reader、受限恢复；cache/snapshots/auth tests |
| `runtime/workspace_foundation`、`self_maintenance` | 文件工具、快照、CAS、保留他人修改的候选回退；`verify-change.mjs` |
| `runtime/desktop_persona/reference-service`、`reference-ui` | 当前 Electron 服务/前端参考源码，需要独立 Electron集成和验收 |
| `runtime/long_term_memory`、`native_dsh/private-vault` | Memory 本地引擎与 provider、Windows Vault 存储 |

上述简称 `multi-life/...` 均相对于 `runtime/native_dsh/`。可先阅读本人工作区 `AGENTS.md` 的源码导航，再查看此表，不读取其他生命数据。状态、记忆与账单只通过 owner-bound 的只读接口读取；某次请求、回执或 fixture 不能代替外部完成证明。

维护流程：记录候选基线和具体文件范围；修改候选；执行相应离线检查；比较最终 bytes/hash；共享 Host 变更由维护者审阅后停 worker、替换并重新启动。能力接受 hash、启停与撤回复用已有 capability bus。回退需核对 dirty 基线，不覆盖他人后续修改。身份、Core、自维护候选和记忆不是同一种数据，不能相互自动覆盖。

本机 source 扩展能被生命发现和提出修改；当前公开部署保护正在运行的共享 runtime，不自动热加载任意候选。提供源码、检查与恢复入口不意味着任意候选已被授权安装。
