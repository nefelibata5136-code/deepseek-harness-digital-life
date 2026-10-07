"""Create one hash-bound editable generation; never overwrite Persona's existing sources."""
from pathlib import Path
import datetime as dt
import hashlib
import json
import argparse

origin = Path(__file__).resolve().parent
base = origin.parents[1]
source = Path('.local/workspace/development/plugins/persona-bluesky')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--version', default='2.1.2')
version = parser.parse_args().version
if not __import__('re').fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', version):
    raise SystemExit('Version must be a numeric semantic version')
target = source / 'versions' / version
target.mkdir(parents=True, exist_ok=False)
(target / 'bundle').mkdir()
files = []
dependency = "createRequire('./runtime/native_dsh/package.json')"
digest = lambda data: hashlib.sha256(data).hexdigest()
for path in sorted((origin / 'bundle').iterdir()):
    if not path.is_file() or path.suffix not in {'.mjs', '.json', '.yml'}:
        continue
    raw = path.read_bytes()
    data = raw.decode('utf-8').replace("createRequire(new URL('../../native_dsh/package.json', import.meta.url))", dependency)
    if path.name == 'client.mjs':
        data = data.replace("const { fetch, ProxyAgent } = require('undici');\n", '')
        data = data.replace("const DEFAULT_ROOT = resolve(import.meta.dirname, '../protected');", "const DEFAULT_ROOT = './runtime/bluesky/protected';")
        data = data.replace("    this.#request = request ?? fetch;\n    if (!request && proxy) this.#dispatcher = new ProxyAgent(proxy);",
                            "    if (request) this.#request=request;\n    else { const {fetch,ProxyAgent}=require('undici');this.#request=fetch;if(proxy)this.#dispatcher=new ProxyAgent(proxy); }")
    dest = target / 'bundle' / path.name
    dest.write_text(data, encoding='utf-8')
    files.append({'candidatePath': dest.relative_to(target).as_posix(), 'formalSourcePath': str(path),
                  'formalSourceSha256': digest(raw), 'candidateSha256': digest(dest.read_bytes())})
for name in ['verify.mjs', 'preview.test.mjs', 'thread-pages.test.mjs', 'media.test.mjs', 'response.test.mjs', 'verify-maintenance.mjs']:
    path = origin / name
    if not path.exists():
        continue
    data = path.read_text(encoding='utf-8')
    if name == 'verify.mjs':
        data = data.replace('mkdtemp, readFile', 'mkdir, mkdtemp, readFile')
        data = data.replace("const root = await mkdtemp(join(tmpdir(), 'persona-bluesky-'));", "const testParent=join(import.meta.dirname,'.test-runs');await mkdir(testParent,{recursive:true});\nconst root=await mkdtemp(join(testParent,'persona-bluesky-'));")
    elif name == 'preview.test.mjs':
        data = data.replace('mkdtemp, rm', 'mkdir, mkdtemp, rm')
        data = data.replace("const root=await mkdtemp(join(tmpdir(),'persona-preview-'));", "const parent=join(import.meta.dirname,'.test-runs');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'persona-preview-'));")
        data = data.replace('resolve(tmpdir())', "resolve(join(import.meta.dirname,'.test-runs'))")
    dest=target/name
    dest.write_text(data,encoding='utf-8')
    files.append({'candidatePath': name, 'formalSourcePath': str(path), 'formalSourceSha256': digest(path.read_bytes()), 'candidateSha256': digest(dest.read_bytes())})
(target/'SOURCE.json').write_text(json.dumps({'generatedAt':dt.datetime.now(dt.timezone.utc).isoformat(),
    'purpose':f'Editable generation {version}; production release acceptance is separate', 'files':files,
    'adaptations':['Fixed Host dependency/journal locations', 'Lazy network dependency for offline permission tests', 'Fixture temp data in writable source directory']},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
(target/'README.md').write_text('''# Bluesky 可维护源码

这是供你自己发展的源码候选；SOURCE.json绑定正式来源、用途和字节hash。旧代保留，不需要手工同步。

- bundle/plugin.mjs：39项工具接口，明确读写工具；名字与行为边界在原生Skill persona-bluesky。
- client.mjs：固定账号/服务、Host私有认证、帖子发布journal/TID/facets/媒体组合。
- search.mjs：官方searchPostsV2；preview.mjs：最多30方向/100项、去重和稳定批号/编号。
- thread-pages.mjs：官方V2完整返回快照、本地稳定游标；保留不可见对象与远端覆盖限制，不重搜第31条以后。
- extended.mjs：Feed、社交、收藏、Chat、通知、安全偏好；每项读取不暗写。
- media.mjs：真实媒体到已有浏览器/视觉入口，仅127.0.0.1读取生成图册，worker关闭时回收；刷新后重新media得到当前URL。assets.mjs：图片重编码、视频job与邮箱/配额。
- stream.mjs：有界Jetstream采样，不开启后台任务。

便宜检查：在本目录运行 node verify.mjs，以及 node --test preview.test.mjs thread-pages.test.mjs media.test.mjs response.test.mjs bundle/extended.test.mjs。
合成传输不读真实凭据、不联网、不发帖，不能代替正式使用验收。
现有文件级恢复工具在 tools/self-maintenance/change.mjs：checkpoint → 修改 → seal → test → accept/rollback；
seal后同文件变化，保留现场做局部patch，禁止HEAD覆盖dirty文件和整目录回滚。

修改候选后通过 capability_manage install_bundle 本目录bundle，inspect核对，再由正式席位life_capability_accept接受完整hash，enable并重新search。
安装默认停用，未知结果先检查，不在工具执行期间refresh。回退使用以前已验证的bundle版本，重新接受hash/enable，只读status与own_posts确认。
回退不删账号、帖子、发布journal、预览映射、密码或原生事件。
正式保护侧来源：./runtime/bluesky/bundle。

Host的capabilities/read-policy.mjs是子Agent精确读白名单；bus和digital-life同时根据真实spawn身份鉴权。
修改这层需Host审查与受控重启，不是修改普通插件就能增加孩子写权限。
凭据只由现有broker在worker内解析，不给模型/孩子secret、任意RPC/endpoint/header。
保留账号固定检查、未知写防重复、300字素、真实读回、取消和超时；不自动修改身份、预算、Vault或调用授权。
''',encoding='utf-8')
print(json.dumps({'editableSource':str(target),'files':len(files),'productionChanged':False},ensure_ascii=False))
