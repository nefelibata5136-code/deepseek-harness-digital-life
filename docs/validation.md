# v0.2.0 公开包验证

2026-10-07 在 Windows / Node 24.16.0 / Python 3.12 下，使用固定 DSH 0.2.0-rc.2 npm 依赖及独立 Python venv 验证公开导出。

| 检查 | 已验证事实 |
|---|---|
| `npm test` | 267 项 Node tests、52 项 Python tests 通过；另含自维护回退、退役搜索、Key 输出屏蔽、压缩、Resident/Schedule 和 Vault 独立检查 |
| `npm run smoke:multi` | 两个 production-mode 原生 worker，合成身份、本地官方 Adapter transport；World 零模型；独立 Core 在 wire；私聊不串流 |
| 单生命停止与重开 | 停 A 时 B 存活；停用标记拒绝重新启动；明确恢复后同一 authority Session，没有重复执行既有输入 |
| 实际 Chrome 加载 | A/B 私聊与只读互聊页面加载，脚本错误 0；未点击发送、未调用模型 |
| 可选服务定向检查 | 官方账单 Decimal 聚合 4 tests；延迟登录跳转 fixture；Dots bridge 17 tests；均不使用真实账号 |
| 全源码语法 | 697 个 JS/Python 文件通过；browser-injected 函数正文按其执行上下文验证 |
| 发布内容扫描 | tree、index、全部可达公开 history 扫描；合成拒绝 fixture 必须匹配当前精确文件 hash；历史提交使用本提交的例外清单 |

Source fixture、production assembly 的离线模拟、实际网页加载与真实线上验收分别记录。以上没有向作者主对话发送消息，没有重启作者运行中的 World/worker，也没有付费模型调用。独立 fixture 中的模型回复只用于驱动机制，不是生命本人的意见或验收。

尚未作为公开安装验收的项目：真实 Provider cache hit/miss、平台登录与官方扣款、外部账号真实往返、独立 Electron 安装器。源码存在或 receipt 不能补足这些验收。更多生命完整启动与其他 OS 的覆盖也需单独验证。

来源和公开文件 hashes 在 `source-provenance.json`。原始日志、合成 Session、截图/浏览器资料和本机路径保留本地，未加入发布仓库。
