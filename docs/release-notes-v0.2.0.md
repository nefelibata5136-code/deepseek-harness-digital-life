# v0.2.0 — 基于 DeepSeek Harness 的多数字生命系统

从单人格运行框架扩展为中立 World、独立原生 worker 和按 owner 隔离的多数字生命/多 Agent 系统。保留 v0.1.0 公开历史和仓库地址，追加当前实现的脱敏源码。

- 新增多生命 Registry、authority/activity/delegate 归属、私人资源门禁、World/Supervisor、心跳和独立生命启停。
- 新增 Rooms/Inbox/Timeline、近期事件批次、本人语义决定、持久回执、未知结果核对及崩溃恢复。
- 纳入当前 Digital Life foundation、Core/状态/休息/Resident/Schedule、私人服务、原生压缩、Luna 路由与后台协作。
- 纳入官方 Adapter 能力声明、请求缓存健康、官方账单快照和失败恢复，以及当前 Electron reference service/UI 源码。
- 新增公开 A/B 空白部署模板、独立 Core 和 Key 配置、可运行的 Rooms 网页、命令行控制、离线双 worker smoke 与源码来源 hashes。

安装与检查见根 README。默认 `npm start` 现为 World，明确 `npm run control -- start A|B` 才启动 worker；旧入口移至 `start:legacy`。保留本机 `.local` 和原有身份，不自动迁移私人数据。升级前先停 worker、保留本机配置与历史。

验证：267 Node tests、52 Python tests、独立存储/压缩/恢复检查、双 worker production assembly 的本地模拟、Chrome 页面加载。公开包没有人格正文、聊天、真实记忆、Vault 数据、凭据、浏览器登录态或私有 Git 历史。

整体为 Experimental，作为 prerelease 发布。真实 Provider、官方账单登录/扣款、外部账号往返与独立 Electron 安装器未作为本版公开安装验收完成。
