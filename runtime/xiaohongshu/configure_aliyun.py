"""Official CLI OAuth setup. Never print login URLs, tokens or CLI raw output."""
import subprocess,threading,time,json,re
from pathlib import Path
CLI=Path('.local/unconfigured/aliyun.exe')
PROFILE='persona-general-ocr'
def main():
    p=subprocess.Popen([str(CLI),'configure','--mode','OAuth','--profile',PROFILE],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
        creationflags=subprocess.CREATE_NO_WINDOW)
    # CLI recreates a buffered stdin reader per prompt. Do not preload later
    # answers: the first reader may consume and discard the following lines.
    p.stdin.write(b'0\n');p.stdin.flush()
    chunks=[]
    def reader():
        while chunk:=p.stdout.read(1):chunks.append(chunk)
    t=threading.Thread(target=reader,daemon=True);t.start()
    print(json.dumps({'profile':PROFILE,'credential_mode':'OAuth','status':'official_cli_browser_authorization_started'}),flush=True)
    announced=False
    answered=set()
    while p.poll() is None:
        output=b''.join(chunks)
        for prompt,value in [(b'Default Region Id',b'cn-shanghai\n'),(b'Default Language',b'zh\n')]:
            if prompt in output and prompt not in answered:
                p.stdin.write(value);p.stdin.flush();answered.add(prompt)
        if not announced and b'oauth2' in output:
            announced=True;print(json.dumps({'status':'browser_login_or_authorization_pending','secrets_printed':False}),flush=True)
        time.sleep(.5)
    t.join(2)
    print(json.dumps({'status':'configured' if p.returncode==0 else 'authorization_failed','exit_code':p.returncode,'secrets_printed':False}),flush=True)
if __name__=='__main__':main()
