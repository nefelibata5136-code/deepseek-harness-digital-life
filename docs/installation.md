# v0.2.0 安装

[首页](../README.md) · [Technical Overview](technical-overview.md) · [Validation](validation.md)

## 安装与离线检查

公开默认环境是可信本机 Windows。需要 Node.js 24+、Git 和可用的 `python`；发布时验证版本为 Node 24.16.0 / Python 3.12。原生 DSH 依赖固定为 0.2.0-rc.2，不根据上游最新文档直接升级内部接线。Vault DPAPI 后端仅面向 Windows。

```powershell
git clone https://github.com/nefelibata5136-code/deepseek-harness-digital-life.git
cd deepseek-harness-digital-life
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
npm test
npm run smoke:multi
npm run audit
```

`scripts/install.ps1` 安装固定 native npm 依赖、独立 Python venv 和 requirements，最后运行 `setup-world.mjs`。安装创建被 Git 忽略的 `.local` 数据根、本机配置和空白 A/B 槽位，不编写 Core、不启用 worker、不调用模型。离线 tests/smoke 使用合成身份与本地 transport，不证明真实缓存、官方扣款或外部操作完成。

## 配置与启动两生命

1. 分别编写 `.local/lives/A/workspace/core.md` 和 `.local/lives/B/workspace/core.md`。Core 由部署者与本人决定；仓库没有作者人格。
2. 通过自己的秘密管理器向 **worker 启动进程**提供 `DL_DEEPSEEK_KEY_A` 和 `DL_DEEPSEEK_KEY_B`，对应两个不同 API Key。Provider 创建 Agent 前加载全部配置 Key 以屏蔽输出；即使只启动 A，也须提供 A/B 两个已配置 Key。不把 Key 写入仓库或 Core。
3. 先运行 World，再在具有上述环境变量的另一个终端明确启动 worker：

```powershell
# 终端 1：World 本身不调用模型
npm start
```

```powershell
# 终端 2：已提供全部配置 Key；处理 Inbox 时可能调用模型与工具
npm run control -- start A
npm run control -- start B
npm run control -- status
```

World 输出 A/B 的 `/chat?life_id=...` 地址；`/peer-chat` 只读观察互聊。默认端口 `19842`，只监听 loopback。页面由 Host 绑定人类 channel token，API 使用 Authorization；控制 token 是本机秘密，保存在 `.local/world/settings.json`，不放入 URL。

## 停止、重开与配置

```powershell
npm run control -- stop A
npm run control -- stop B
```

首次所有 worker 均停用，Resident 周期唤醒与官方账单 producer 默认关闭。明确启动后，已有 Inbox 或本人 Schedule 仍可能产生付费请求。忙碌停止报告 `WORKER_BUSY`，待活动结束后重试，不静默强杀。退出 World 前先停 worker；重开用同一 `.local` 保留身份、Session 和通信记录。

`config/world.example.json` 仅用于首次生成；以后以 `.local/world/settings.json` 为本机配置。`DL_WORLD_ROOT` 可指定另一 World 配置目录，`DL_PYTHON` 可选择 Python。首次 setup 前可加更多槽位，但完整启动验收覆盖 A/B；三、四生命机制 fixtures 不等于任意规模部署验收。Memory、账单和 Codex 登录配置见 [Optional Services](optional-services.md)。

## 升级与首版兼容

本地配置、随机身份、token、Session、Core、Memory、Vault 与浏览器资料均被 Git 忽略。首次安装不复制或生成生命身份正文，也不唤醒作者正式部署。升级公共源码前先停 worker，备份本机 `.local` 并审查 release notes；保留原 settings/lifeId/authoritySessionId，不删除历史。首版兼容入口是 `npm run start:legacy`，其单生命 profile 与新版独立，不能混用身份。
