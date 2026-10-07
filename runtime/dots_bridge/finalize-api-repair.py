"""Record bounded negative trigger evidence, without touching credentials or task DB."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent
report = root.parent.parent / 'reports/dots_bridge/api-repair-20261006'
observations = json.loads((report / 'trigger-observations.json').read_text(encoding='utf-8'))
samples = observations['samples']
assert samples and all(s.get('ok') is True and not s.get('has_more') and s.get('dot_reply_count') == 0 for s in samples), 'OBSERVATION_CHANGED_REVIEW_REQUIRED'
from datetime import datetime
config_path = root / 'protected/connection.json'
config = json.loads(config_path.read_text(encoding='utf-8'))
assert config['sender_mode'] == 'delegated_user' and config['ui_sending_enabled'] is False
for mode, key in [('bot', 'bot_trigger_probe'), ('delegated_user', 'delegated_user_trigger_probe')]:
    sample = next(s for s in reversed(samples) if s['mode'] == mode)
    duration = (datetime.fromisoformat(sample['observed_at']) - datetime.fromtimestamp(float(sample['thread']), tz=datetime.fromisoformat(sample['observed_at']).tzinfo)).total_seconds()
    config[key] = {'result': 'no_reply_observed', 'message_ts': sample['thread'], 'observed_at': sample['observed_at'], 'observation_seconds': round(duration), 'evidence': 'reports/dots_bridge/api-repair-20261006/trigger-observations.json'}
config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
files = {
    'connection.before.json': config_path,
    'slack.before.mjs': Path('.local/workspace/development/plugins/persona-dots/slack.mjs'),
    'native-test.before.mjs': root / 'native-slack-test.mjs',
    'tests.before.mjs': Path('.local/workspace/development/plugins/persona-dots/bridge.test.mjs'),
    'plugin-readme.before.md': Path('.local/workspace/development/plugins/persona-dots/README.md'),
    'control-readme.before.md': root / 'README.md',
    'skill.before.md': Path('.local/workspace/.dsh/skills/persona-dots/SKILL.md'),
    'capabilities.before.md': Path('.local/workspace/capabilities.md'),
}
backup = root / 'protected/repair-20261006'
digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
manifest = [{'path': str(path), 'before': str(backup / name), 'before_sha256': digest(backup / name), 'after_sha256': digest(path)} for name, path in files.items()]
(backup / 'sealed-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
last = [next(s for s in reversed(samples) if s['mode'] == mode) for mode in ['delegated_user', 'bot', 'delegated_user_as_user']]
summary = {'session_id': 'b2f514fd-a036-5cfe-8f99-dcdec71c2e28', 'task_id': 'dot-86e17044-4e08-5e8e-8b82-19d3fb0b5a13', 'ui_used': False, 'sending_verified': True, 'round_trip_passed': False, 'failure_hop': 'Slack message -> Dot response', 'slack_api_error': None, 'observations': last, 'credentials_source': 'windows-credential-manager', 'sender_mode': 'delegated_user'}
(report / 'acceptance-summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(summary, ensure_ascii=False))
