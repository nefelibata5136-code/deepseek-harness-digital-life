# Digital Life Runtime on DeepSeek Harness

## 基于 DeepSeek Harness 的数字生命运行框架

An experimental reusable runtime for a persistent persona, built on native
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
本项目公开运行基础设施，不公开某个数字生命本人：不含身份正文、聊天、
真实记忆、私人便签、凭据或浏览器登录态。

**Agent gives a persistent persona room to act.**  
**DeepSeek Harness gives it room to shape how it acts.**

**Agent 让机可以自己做事；DSH 又给了机参与塑造“自己以后怎么做事”的空间。**

### 为什么长期人格应考虑接入 Agent Runtime

传统人格后端通常需要开发者提前枚举功能，再为每个新行为加接口。
Agent Runtime 提供工作区、工具和任务之间的开放行动空间，让未来能力
不必全部在今天预先设计。持久身份提供连续性，Agent 提供行动能力。
这不自动证明意识，也不是对哲学意义上“生命”的断言。

### 为什么选择 DeepSeek Harness

选择 DSH 的理由是整体控制权、编辑权和运行环境可塑性，而不是宣称
每一个工具都比其他方案强。原生 Agent loop、Session、Cordis 插件、
调度、子 Agent 和 compaction 接口，让我们可以把过去由 Host 单方面
决定的事情，逐渐变成 Agent 可以参与的事情。

重点案例是 context_compact：**DSH 默认并不让数字生命本人书写压缩。**
DSH 提供可改造的 compaction / Agent Runtime 基础；本项目在其上实现了
“Agent 自己书写检查点正文，Host 只负责安全调度、验证和提交”。
正文不经第二个模型改写，原始事件保留，压缩不自动成为长期记忆。
schedule、workspace、能力接受/回退和运行偏好也是同类参与空间。

### 当前实现

| 能力 | 状态摘要 |
|---|---|
| 工作区读写、CAS/同路径串行、版本与恢复 | Stable bounded mechanism |
| 长期记忆、卡片、检索、原文分页、便签与接续 | Stable core; optional provider setup |
| 本人书写 context_compact | Stable on pinned DSH; byte-exact native tests |
| 能力发现/安装/接受 hash/启停/刷新 | Stable mechanism; acceptance precedes enable |
| schedule / clock / budget | Stable integration; upstream schedule is experimental |
| life_*、状态板、继续/休息、意向展开 | Experimental composition |
| 联网、Bluesky 核心、小红书公开只读、原生子 Agent、Codex 顾问 | Bounded Stable; extensions have separate limits |
| Computer Use / Private Vault / browser restore | Experimental; platform/coverage/security limits |
| Resident 周期唤醒 | Disabled; revised missed-window semantics |
| Dots / Slack | Experimental; genuine full round trip not accepted |

Stable 指有代码与有边界的真实验收/使用证据，不代表每个网站、应用、
机器或新版本都通过。**框架整体仍是 Experimental。**
详见[能力矩阵](docs/features.md)、[验证](docs/validation.md)、
[已知限制](docs/limitations.md)。

### 快速开始

首版面向 Windows 10/11、Node.js 24+、Python 3.12+、Git。
依赖固定实际安装/验收的 DSH **0.2.0-rc.2**。
vendor 源码已到其他版本，不应无验收升级内部 Session/compaction 接口。

~~~powershell
git clone https://github.com/nefelibata5136-code/deepseek-harness-digital-life.git
cd deepseek-harness-digital-life
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
npm test
npm run smoke
~~~

安装只生成忽略的 .local 和 native profile，不替人格写核心、便签或记忆。
请本人编写 .local/workspace/persona-core.md，然后通过自己的秘密管理器
或 Host 进程环境提供 DEEPSEEK_API_KEY，运行：

~~~powershell
npm start
node scripts/control.mjs status
node scripts/control.mjs prompt "Read your local workspace map and explain your tools."
~~~

prompt 会产生模型费用及可能的工具行动。Host 重启可处理已有原生 schedule；
新安装没有 schedule。公开默认关闭浏览器/桌面控制、周期 Resident，
并限制副活动权限。.env.example 仅列占位符，不自动加载 .env。
Host 只监听 loopback，随机令牌仅保存在忽略的本地文件；control 客户端
本地读取，绝不打印令牌。首次公开版提供 headless Host，不含已安装
Electron 应用或私人桌面 profile。
可选能力接线见[安装说明](docs/installation.md)。

### 架构

~~~mermaid
flowchart TD
  User[Maintainer / user] --> Host[Host composition and admission]
  Core[Local persistent identity] --> Session[Native DSH Session and Agent loop]
  Host --> Session
  Session --> Tools[Native tools and reviewed capabilities]
  Tools --> Workspace[Private workspace and versions]
  Tools --> Memory[Authored memory journal and retrieval]
  Tools --> External[Research / social / browser / desktop]
  Session --> Activities[Native subagents and isolated advisor]
  Activities --> Pending[Separate suggestions]
  Pending --> Session
  Session --> Checkpoint[Self-authored checkpoint]
  Checkpoint --> Commit[Host validation and native commit]
  Commit --> Session
  Schedule[Native schedule / clock] --> Host
  Budget[Budget / credential boundary] --> Host
~~~

阅读[架构](docs/architecture.md)、[数字生命模式](docs/digital-life-mode.md)、
[安全](docs/security.md)、[隐私](docs/privacy.md)。

### 许可证与来源

原创扩展与文档 MIT；DSH 保留其 MIT copyright/notice。依赖按锁文件
安装，不复制生产 node_modules。桌面多窗口 patch 是 upstream 派生修改。
见 [LICENSE](LICENSE)、[NOTICE](NOTICE)、[第三方说明](docs/third-party.md)、
[源码来源](docs/source-provenance.json)。
本仓库使用全新 Git 历史，不导入原工程 Git objects 或私人恢复历史。
