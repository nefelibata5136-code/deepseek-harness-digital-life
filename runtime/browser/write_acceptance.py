"""Project only verified metadata; private Session/image/profile data stay private."""
import json
import hashlib
import re
import zipfile
from pathlib import Path
from datetime import datetime, timezone
from browser_control import status, owned_processes, ROOT
from host_acceptance import BASE, command

REPORT = BASE/'reports/browser'
load = lambda p: json.loads(p.read_text(encoding='utf-8'))
cloud = load(ROOT/'host-continue.json')
resumed = load(ROOT/'host-restart.json')
identity = load(ROOT/'host-identity.json')
assert all(v['state']=='completed' and not v.get('errors') for v in [cloud,resumed,identity])
sid = cloud['sessionId']
path = next((BASE/'runtime/native_dsh/home/sessions').rglob(sid+'/session.v4.jsonl'))
events = [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines()]
texts, images = [], []
for event in events:
    if event.get('type') != 'tool/result': continue
    for block in event.get('data',{}).get('message',{}).get('content',[]):
        if block.get('type')=='image': images.append(block['attachment'])
        elif block.get('type')=='text':
            try: value=json.loads(block['text'])
            except ValueError: continue
            if isinstance(value,dict): texts.append(value)
calls = [e['data'] for e in events if e.get('type')=='tool/call']
assert any(c['name'].endswith('browser_type') and json.loads(c['arguments']).get('text')=='拉格朗日点' for c in calls)
posts = [v for v in texts if 'total_characters' in v and re.search(r'/explore/[a-f0-9]+',v.get('url',''))]
comment_pages = [v for v in posts if '共 1 条评论' in v.get('text','')]
assert comment_pages and images and '黑底' in cloud['text']
current = status()
before = load(ROOT/'before-identity-recheck.json')
host = command('/status')
assert host['pid'] != before['host_pid']
assert current['identity'] == before['browser']['identity']
browser_pids = [p.pid for p in owned_processes() if not any(a.startswith('--type=') for a in p.cmdline())]
assert len(browser_pids)==1 and browser_pids[0] in before['chrome_pids']
assert texts[-1].get('identity') == current['identity']
archive = ROOT/'backups/20261004-201843-c7801902.zip'
with zipfile.ZipFile(archive) as z:
    manifest=json.loads(z.read('manifest.json'))
    assert all(hashlib.sha256(z.read('profile/'+name)).hexdigest()==expected for name,expected in manifest['sha256'].items())
core = Path('.local/workspace/persona-core.md')
assert hashlib.sha256(core.read_bytes()).hexdigest()=='beaf1f1028235dd4b9d88874c3a6d52ee661737784fc41f8c4e61a2d2c71d343'
result = {
    'passed_minimum_browser_acceptance':True, 'observed_at':datetime.now(timezone.utc).isoformat(),
    'architecture':'Persona / DeepSeek V4.1 Flash -> native Harness -> official MCP client -> browser-use direct tools -> owned local Chrome',
    'browser_use':'0.13.10', 'harness':'0.2.0-rc.2', 'second_browser_agent':False,
    'profile':current['profile'], 'identity':current['identity'], 'identity_basis':current['identity_basis'],
    'core_unchanged':True, 'human_completed_xiaohongshu_login':True,
    'local_actions':load(REPORT/'local-actions.json'),
    'native_image_admission':True, 'real_flash_visual_interpretation':True,
    'xiaohongshu':{'search_input':'拉格朗日点','search_input_and_click_verified':True,
        'posts':list({v['title']:v['url'] for v in posts}.items()),
        'post_body_read':True,'post_image_screenshots':True,'loaded_comments_read':1,
        'visual_details':['米色纸张封面','黑底日地示意图；白色太阳、蓝色地球、绿色 L1-L5 标签'],
        'no_social_submission':True},
    'harness_restart':{'before_pid':before['host_pid'],'after_pid':host['pid'],
        'same_chrome_browser_process':True,'chrome_browser_pid':browser_pids[0],
        'same_profile_tag':True,'login_retained':True,'image_tools_work_after_restart':True},
    'desktop_task':{'title':'人格的持久 Chrome 验收','session_id':sid,'user_confirmed_visible':True},
    'backup':{'private_archive':str(archive),'files_verified':len(manifest['sha256']),
        'sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'restore_verified':False,
        'restore_limitation':'Windows refused directory rename; original profile and extracted copy preserved. No deletion performed.'},
    'budget':{'daily_limit_cny':50,'warning_cny':40,'conservative_cny':45,
        'existing_ledger_preserved':True,'previous_unknown_usage_accounted_at_upper_cny':'2.228224'},
    'image_attachments_in_native_session':len(images),'raw_credentials_read':False,
    'limitations':['Future site reauthentication/security gates require human takeover.',
        'Closed-profile backup verified; restoration remains unverified.',
        'Loopback CDP is for trusted local processes; it is not a same-user malicious-process sandbox.']}
REPORT.mkdir(parents=True,exist_ok=True)
(REPORT/'acceptance.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
proof_path=BASE/'reports/task_A/readiness.json'
proof=load(proof_path)
proof['browser_release']['paid_visual_acceptance']='passed; see reports/browser/acceptance.json and the native Persona task'
proof_path.write_text(json.dumps(proof,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'passed':True,'identity':current['identity'],'harness_restart':result['harness_restart'],
    'xiaohongshu_posts':len(result['xiaohongshu']['posts']),'loaded_comments_read':1,
    'backup_files_verified':len(manifest['sha256']),'restore_verified':False,'daily_budget_cny':50},ensure_ascii=False))
