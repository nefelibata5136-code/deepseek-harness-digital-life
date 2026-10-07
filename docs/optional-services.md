# 可选服务配置

所有账号与登录态保留在 `.local` 或明确的本机凭据边界。公开例子中的变量名不是已配置凭据。

## Memory

本地记录与离线测试可运行。在线检索需本机设置 `DASHSCOPE_API_KEY`，并在 `.local/world/settings.json` 填写自己的 `memoryWorkspaceId`。数据源按 owner 绑定，不能从另一个生命工作区隐式导入。付费 embedding/rerank 的真实调用尚未作为公开安装验收执行。

## 官方 DeepSeek 账单

现代 World 的 Key 绑定是本机 `settings.lives[].keyEnv`。在 `.local/world/billing-identities.json` 按实际 lifeId 配置官方平台对应的 `{ "name": "官方 Key 名", "tracking_id": "官方 tracking ID" }`；复制空模板 `config/billing-identities.example.json` 后自行填写。不得填 API Key 本文。

安装包固定了作者使用的 Playwright 版本，Chrome 自行安装。Chrome 的专用账单 profile 与工作用浏览器分开；当前默认位于本机 LOCALAPPDATA 下 `PersonaHost/DeepSeekBillingBrowser/deepseek-billing-profile`。必须在该 profile 完成人类登录。不要复制作者 profile、cookie 或平台响应。

读取器 `runtime/deepseek_billing/service/query.mjs` 读取官方 `by_api_key/cost` 响应，内存中验证唯一 masked prefix/suffix、长度、官方名字与预期 tracking ID，以 Decimal 聚合；失败保留旧值并标过期。未知账单不回退到账户总额或本地估算。

公共 worker 默认没有 producer。已配置登录和映射后，可以用 `DL_WORLD_ROOT` 指向本机 World、提供对应 Key 环境，明确运行 `node scripts/billing-producer.mjs`；先查看该模块及 `runtime/deepseek_billing/service/producer.mjs` 的绑定，保证仅一个 producer。本版交付读取器/缓存/恢复机制与离线检查，未执行真实登录、抓账或扣款验收；默认无需启动该可选服务。

## 子 Agent 与外部工具

`runtime/native_dsh/subagent-router/settings.json` 控制默认 Codex Luna、并发、超时及 DeepSeek 委派开关。更改配置后停止该 worker、重新启动并检查实际 provider/model 与 owner；不能只凭文字提示认定接线已改变。Codex 需要本机已授权登录，不上传 auth.json。完全访问模式按当前源码保留，并不提供 OS 沙箱。

本地 web-search CLI 已退役，使用原生 DSH `web_search`/`web_fetch`；退役脚本拒绝调用，不提供暗中 fallback。浏览器、桌面、Bluesky、Slack/Dots 的代码供独立集成；需要各自配置、权限及真实往返验收。仅有消息 receipt 不等于外部 Agent 已读或回复。
