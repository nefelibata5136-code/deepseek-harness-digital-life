"""Read-only tree/index/history audit; never prints matching secret values."""
import argparse,hashlib,json,os,re,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SKIP={'.git','node_modules','.venv','venv','__pycache__','.local','home','reports'}
PATTERNS={
 'provider-key':r'\bsk-[A-Za-z0-9_-]{18,}',
 'github-token':r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})',
 'slack-token':r'\bxox[baprs]-[A-Za-z0-9-]{12,}',
 'private-key':r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
 'jwt':r'\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}',
 'auth-literal':r'(?i)\bBearer [A-Za-z0-9_./+=-]{24,}',
 'machine-path':r'''(?i)(?:[A-Z]:[/\\]+Users[/\\]+|["']/(?:home|Users)/[^/\s"']+/)''',
 'account-id':r'\b(?:ws-[a-z0-9]{12,}|[TCU]0[A-Z0-9]{9,}|did:plc:[a-z2-7]{24})\b',
 'credential-assignment':r'''(?im)(?:api_key|access_token|refresh_token|app_password|client_secret)\s*[:=]\s*["']([A-Za-z0-9_+/=-]{20,})["']''',
}
PROHIBITED={'.db','.sqlite','.sqlite3','.png','.jpg','.jpeg','.webp','.zip','.jsonl','.log','.key','.pem','.p12','.pfx'}
def git(*args):
 return subprocess.run(['git','-C',str(ROOT),*args],capture_output=True,check=True).stdout
def source_files():
 for directory,dirs,files in os.walk(ROOT):
  dirs[:]=[d for d in dirs if d not in SKIP]
  for name in files:
   p=Path(directory)/name
   if p.is_symlink() or p.is_junction():raise ValueError('Links are not public source: '+str(p.relative_to(ROOT)))
   yield p.relative_to(ROOT).as_posix(),p.read_bytes()
def scan(files,allow=None):
 findings=[];reviewed=[];count=0
 if allow is None:
  try:allow=json.loads((ROOT/'config/audit-exceptions.json').read_text('utf-8'))
  except FileNotFoundError:allow={}
 for name,data in files:
  count+=1
  if Path(name).suffix.lower() in PROHIBITED or (Path(name).name.startswith('.env') and Path(name).name!='.env.example'):
   findings.append({'file':name,'rule':'prohibited-artifact','line':0})
  try:text=data.decode('utf-8')
  except UnicodeError:
   findings.append({'file':name,'rule':'unexpected-binary','line':0});continue
  digest=hashlib.sha256(data).hexdigest()
  for rule,pattern in PATTERNS.items():
   matches=list(re.finditer(pattern,text))
   if not matches:continue
   if allow.get(name,{}).get('sha256')==digest and rule in allow[name].get('rules',[]):
    reviewed.append({'file':name,'rule':rule,'matches':len(matches)});continue
   for m in matches:findings.append({'file':name,'rule':rule,'line':text.count('\n',0,m.start())+1})
 return {'files':count,'findings':findings,'reviewed_synthetic_patterns':reviewed,'passed':not findings}
def main():
 p=argparse.ArgumentParser();p.add_argument('--mode',choices=['tree','index','history'],default='tree');a=p.parse_args()
 if a.mode=='tree':result=scan(source_files())
 elif a.mode=='index':
  names=git('ls-files','--cached','-z').decode().split('\0')
  result=scan((n,git('show',':'+n)) for n in names if n)
 else:
  commits=git('rev-list','--all').decode().splitlines();results=[]
  for commit in commits:
   names=git('ls-tree','-rz','--name-only',commit).decode().split('\0')
   allow=json.loads(git('show',commit+':config/audit-exceptions.json'))
   r=scan(((n,git('show',commit+':'+n)) for n in names if n),allow);r['commit']=commit;results.append(r)
  result={'passed':all(r['passed'] for r in results),'commits':len(commits),'results':results}
 print(json.dumps({'mode':a.mode,**result},ensure_ascii=False,indent=2));return 0 if result['passed'] else 1
if __name__=='__main__':sys.exit(main())
