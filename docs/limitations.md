# v0.2.0 已知限制

整体状态为 Experimental，当前公开默认环境为可信本机 Windows。默认现代 World/worker 入口可独立配置与运行；三、四生命 fixture 覆盖机制，但完整启动 smoke 覆盖两个生命。

- 同一 Windows 用户的完全访问终端、Codex worker 和原生子进程不是 OS 级隔离。普通 Host 工具的 owner 门禁不能替代系统用户权限边界。
- 公开包没有作者人格、生命记录、登录态与桌面二进制。首次 Core 必须本人编写。旧私人数据没有自动迁移。
- 默认关闭 Resident 和官方账单 producer；明确启动 worker 仍可能处理已有 Inbox/Schedule。忙碌停止先报告状态，不自动强杀。
- 隔离模型传输证明原生接线和持久恢复，不证明真实缓存 hit/miss、Provider 价格或官方扣款。静态头与连续请求 prefix 的离线检查另外记录。
- Memory 在线 provider、官方账单登录/映射、Codex 登录与外部社会工具需独立配置。不要把 receipt、fixture 或代码存在写成线上完成。
- Electron reference UI/service 随源码交付，依赖官方 Electron 环境；本版默认提供 Rooms 网页和命令行控制，未交付独立 Electron 安装器。历史 operator/live acceptance 脚本含显式未配置路径，应先审阅，不作为默认安装流程。
- DSH 内部 Session/Adapter 能力接线以锁定版本为准，升级时需要重新验证 system update、tools、Core 与已有历史前缀。
- Vault 使用 Windows DPAPI；Linux/macOS 安装与桌面控制未做公开验收。
