# 原生多 Agent 路由

默认 `provider=codex`、`model=gpt-5.6-luna`，设置在同目录 `settings.json`。DeepSeek 子 Agent 默认停用，显式请求也拒绝；修改 `deepseekEnabled` 并明确重启 worker 可恢复。`permissionMode=dangerously-bypass-approvals-and-sandbox` 与顾问配置均为完全访问，不是隔离沙箱。

后台提交返回 child_id，完成通知精确投递到父 Session，完整结果通过 subagent_results 获取；结果不自动写入 Core/Memory。源码 `router.mjs`、`slots.mjs`、`digital-life/codex-advisor.mjs`，检查 `router.test.mjs`、`slots.test.mjs`、`digital-life/codex-advisor.test.mjs`。公网或付费委派需要独立本机登录与明确任务。

修改前保留 settings 与候选基线；停止 worker 后重新启动才能加载新路由。出错先查 owner/session/model 与本机日志，恢复旧 settings；不要通过多次付费调用盲目排查。
