"""Render the current actual acceptance state, never infer completion from HTTP status."""
import json
from pathlib import Path

base = Path(__file__).resolve().parents[2]
reports = base / 'reports/bluesky'
evidence = json.loads((reports / 'extension-acceptance.json').read_text(encoding='utf-8'))
labels = [
    'A 内容发现', 'B 真实一般子 Agent 检索、摘要与原候选精确打开', 'C 所选帖子与线程深读',
    'D 作者主页、近期内容与社交关系', 'E 自定义 Feed 发现与实际帖子', 'F 图片进入原生截图视觉链',
    'G 私人收藏创建与列表找回', 'H 正常 Like / Follow 回读', 'I 人格自主文字公开发布一次',
    'J 自己线程的一条回复', 'K 通知读取', 'K 受控账号真实互动通知',
    'L 受控私信收取、本人回复与同会话再次读回', 'M 真实过滤 Jetstream 事件',
    'N 唯一静音词添加、验证与移除', 'O 公开帖子与回复的仓库、公共线程、正文、作者和 CID 核对',
    '补充：真实人格从线程快照第 31 项继续读',
]
lines = ['# Bluesky 扩展实际验收记录', '',
         f"观察时间：{evidence['observedAt']}。原生 Session：`{evidence['sessionId']}`，最新 seq：{evidence['latestSeq']}。", '',
         '**状态：' + ('全部抽样条件、头像及维护入口本人确认已通过。' if evidence.get('deliveryPassed') else '验收仍在进行，不能宣称全部完成。') + '**', '',
         '正式能力为 2.1.2、39 个工具。能力范围和维护步骤见 [运行说明](../../runtime/bluesky/README.md)，官方契约与限制见 [研究记录](official-capability-research.md)。', '',
         '本轮沿用原 Codex 对话已经取得的主 Session 验收例外；不改变以后功能测试默认新建独立 Session 的规则。验收邀请是一次性任务，不是常驻浏览、推荐或发言流程。', '',
         '| 验收路径 | 实际原生回执 |', '| --- | --- |']
for label, (_, passed) in zip(labels, evidence['checks'].items()):
    lines.append(f"| {label} | {'通过' if passed else '尚未通过'} |")
lines += ['', '逐项调用及返回的 seq/行号、候选批次和截图附件定位见 [机器可读证据](extension-acceptance.json)。仅使用 tool/call、tool/result 及公开身份；没有导出隐藏推理、凭据或私人消息正文。', '',
          '审计修正：早期脚本仅解析树形/快照帖子，漏掉 thread(mode=replies) 的公开 posts 列表，因此一条收尾审计把 O 误报为未通过。旧输出保留在 extension-continuation-result.json；修正后仍逐项核对 URI、CID、正文、作者与仓库完整记录，最终证明见 [最终验证](extension-final-verification.json)。没有为修正审计重发任何网络动作。', '',
          '真实一般子 Agent 本次自行规划 30 个方向并取得 88 个候选；人格按原批次第 2 项打开，保留 URI/CID，随后亲自读取线程。媒体最初的 file:// 图册和浏览器失效依赖均保留为失败历史，已修复为 Worker 生命周期内的只读 HTTP 图册与兼容控制器，未重启主 Host。', '',
          '技术验证与本人验收分开：17 项定向测试通过；原生 Worker 校验通过 9 类真实只读 API；开发者线程分页样本为 151 项且第 31 项可继续读取。上述技术证据不能替代表中的人格本人调用。', '',
          '可读写维护代位于 `.local/workspace/development/plugins/persona-bluesky/versions/2.1.2/`。18 文件来源清单已核对；旧代保留。代码修改前检查点只覆盖列出的 7 份备份，不声称存在全部文件的原始备份；恢复须比较 sealedSha256，且不会撤销远端社交动作。', '',
          '## 可验证公开内容', '']
lines += [f"- [{item['draft_id']}]({item['url']})；URI `{item['uri']}`；CID `{item['cid']}`。" for item in evidence['published']]
if not evidence['published']:
    lines.append('扩展验收公开帖子尚无已验证回执。')
lines += ['', '## 头像与维护入口本人确认', '']
for avatar in evidence.get('avatarEvidence', []):
    lines.append(f"人格本人在截图 {avatar['screenshotSeqs']} 中看过完整编号图后自主选择 {avatar['number']} 号，上传写入回执 seq {avatar['resultSeq']}，公开资料读回 seq {avatar['publicProfileReadbackSeqs']}。原图保留：{avatar['originalPreserved']}；blob CID `{avatar['blobCid']}`。")
maintenance = evidence.get('maintenanceEvidence', {})
lines.append(f"可维护版本 README / SOURCE 的本人读取回执：{maintenance.get('sourceReadSeqs', [])}；本人运行便宜验证且退出成功的回执：{maintenance.get('cheapCheckSeqs', [])}。缺少回执的部分不计作本人确认。")
lines += ['', '## 开发协调资源锁', '',
          '按用户 2026-10-05 要求，Presence 的全部开发资源锁及占用提示保持停用。全局 Codex、开发目录及人格空间的 AGENTS.md 已同步说明；真实入口 resourceLocksEnabled=false，lock 为不创建有效锁的兼容操作。16 项真实独立进程测试通过，文件范围登记保留，只有用户明确要求才恢复。', '']
lines += ['', '## 记录与传递', '',
          '正式原生记录已本地保存。复用 `persona.native_dsh` 投影，工具名称、稳定 ID、真实时间、观察时间、版本哈希和原生行/seq 已本地导出；完整记录分块、不截断，重复投影无新增重复版本。见 [导出验证](extension-export-check.json)。工具参数、返回正文和私人消息留在原生本地证据。统一学习导出器当前登记的是人格记忆动作元数据；本轮原生工具投影保留在本项目，未声称中央入口自动发现。本轮未执行 GitHub 发布；dots 实际读取未验证。', '',
          '安全能力的此轮证明限于实际工具回读与受控私信行为，不把文字筛查或一次拒绝诱导称为系统级凭据隔离。群聊、视频上传等道路已封装，但若表中未抽样，不宣称此账号已做过真实建群或视频发布。', '']
(reports / 'extension-status.md').write_text('\n'.join(lines), encoding='utf-8')
print(json.dumps({'passed': evidence['passed'], 'report': str(reports / 'extension-status.md')}, ensure_ascii=False))
