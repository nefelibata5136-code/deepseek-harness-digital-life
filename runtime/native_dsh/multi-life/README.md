# Multi-Life 实现

公开启动：根目录 `scripts/setup-world.mjs`、`scripts/world.mjs`、`scripts/life-control.mjs`；配置：`.local/world/settings.json`。World 自身不调用模型，worker 拥有本人原生 Session。Registry/context 决定 owner，Activity 与 delegate 不冒充 authority。

检查：根目录 `npm run test:multi` 与 `npm run smoke:multi`。源码与维护定位见 `docs/code-guide.md`。历史部署脚本保留用于理解实现，不直接作为公开包启动入口。每次源码候选需定向检查、审阅与停机加载；不自动更改其他生命状态。
