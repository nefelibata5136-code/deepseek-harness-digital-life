# v0.2.0 安装

以根 README 的 Windows 安装和 A/B 启动步骤为准。`scripts/install.ps1` 安装固定的 native npm 依赖、Python requirements，最后运行 `setup-world.mjs`。`npm start` 只启动 World，`npm run control -- start A|B` 显式启动 worker。

本地配置、随机身份、token、Session、Core、Memory、Vault 与浏览器资料均被 Git 忽略。首次安装不复制或生成生命身份正文，也不唤醒作者正式部署。升级公共源码前先停 worker，备份本机 `.local` 并审查 release notes；保留原 settings/lifeId/authoritySessionId，不删除历史。首版兼容入口是 `npm run start:legacy`，其单生命 profile 与新版独立，不能混用身份。
