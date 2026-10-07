"""Publish a first editable source baseline, without overwriting Persona's changes."""
from pathlib import Path
import json

origin = Path(__file__).resolve().parent
target = Path('.local/workspace/development/plugins/persona-bluesky')
target.mkdir(parents=True, exist_ok=False)
(target / 'bundle').mkdir()
for name in ['package.json', 'cordis.patch.yml', 'client.mjs', 'plugin.mjs', 'avatars.json']:
    data = (origin / 'bundle' / name).read_text(encoding='utf-8')
    if name == 'client.mjs':
        data = data.replace("const require = createRequire(new URL('../../native_dsh/package.json', import.meta.url));\nconst { fetch, ProxyAgent } = require('undici');",
                            "const require = createRequire('./runtime/native_dsh/package.json');")
        data = data.replace("const DEFAULT_ROOT = resolve(import.meta.dirname, '../protected');",
                            "const DEFAULT_ROOT = './runtime/bluesky/protected';")
        data = data.replace("    this.#request = request ?? fetch;\n    if (!request && proxy) this.#dispatcher = new ProxyAgent(proxy);",
                            "    if (request) this.#request = request;\n    else {\n      const { fetch, ProxyAgent } = require('undici');\n      this.#request = fetch;\n      if (proxy) this.#dispatcher = new ProxyAgent(proxy);\n    }")
    (target / 'bundle' / name).write_text(data, encoding='utf-8')
test = (origin / 'verify.mjs').read_text(encoding='utf-8')
test = test.replace("mkdtemp, readFile", "mkdir, mkdtemp, readFile")
test = test.replace("const root = await mkdtemp(join(tmpdir(), 'persona-bluesky-'));",
                    "const testParent = join(import.meta.dirname, '.test-runs');\nawait mkdir(testParent, { recursive: true });\nconst root = await mkdtemp(join(testParent, 'persona-bluesky-'));")
(target / 'verify.mjs').write_text(test, encoding='utf-8')
(target / 'README.md').write_text('''# Bluesky 的可维护源码

这是你可读写的源码和不联网技术检查入口，不是你的心境或发言。
当前正式运行仍使用保护侧已验证的首版release；这里是供你继续修改的基线。
两处不需要手工同步：你在这里继续发展，保护侧首版作为回退版本保留。

- `bundle/client.mjs`：固定API边界、帖子投影、发现、线程、发布防重和头像。
- `bundle/plugin.mjs`：11个原生工具的schema、完整JSON返回和超时。
- `bundle/avatars.json`：已审查的10张候选及hash；头像不允许任意文件上传。
- `verify.mjs`：仅合成传输、临时目录；验证失联重试、草稿冲突、TID、冷恢复和结果无凭据。不联网，不发帖，不读取真实凭据。
- 使用与边界的唯一正文：原生Skill `persona-bluesky`。

## 修改与检查

先读源码，再改你实际想改的一小处。检查命令：

```text
node --preserve-symlinks-main ".local/workspace/development/plugins/persona-bluesky/verify.mjs"
```

临时数据只在本目录 `.test-runs`，结束自动清理本次创建的唯一临时目录。
这条是技术检查，不能冒充你自己通过正式能力读真实帖子/发布的验收。
命令执行用你已有的受限终端；不要找真实密码、Token或复制其他Host配置来修错。

## 切换和恢复

当前工具坏了先 `capability_list`，必要时只 `capability_manage disable bluesky`。
自己的新版本准备好后，用已有能力管理器 `install_bundle` 安装本目录的 `bundle`，
inspect核对已安装bundle；安装默认停用。由正式席位通过 `life_capability_accept`
接受当前完整版本hash，然后enable，再重新capability_search取新schema。
不要在工具调用进行中refresh，不用未验证源码直接覆盖运行中进程。

恢复本轮已验证首版时，同样install_bundle，target用：
`./runtime/bluesky/bundle`。
inspect、life_capability_accept、enable、重新search，然后以status/own_posts只读检查。
回退只切换代码，不删除账号、帖子、发布journal、密码或原始Session。
新的语义测试要重新真实读回，不能因为技术测试通过就写“本人验收通过”。

## 不能顺手改的边界

密码只由现有credential broker在worker内解析，不能新增把secret发给模型的接口。
保留固定账号身份检查、网络端点限制、只读凭据引用、严格JSON、取消与超时。
保留300字素上限、稳定draft_id/TID、完整读回、未知结果不换ID重发。
活动/顾问无正式发言权。profile更新保留已有字段，头像原图和真实历史不覆盖。
这不是恶意本机代码/同一Windows管理员的安全沙箱，升级Host权限边界须单独审查。
普通浏览不需要新增后台任务；只改用途和逻辑，不自动扩大外部发布授权。
''', encoding='utf-8')
print(json.dumps({'source': str(target), 'editable': True, 'productionReleaseChanged': False}, ensure_ascii=False))
