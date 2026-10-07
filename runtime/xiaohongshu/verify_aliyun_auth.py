"""Real SDK authentication and OAuth renewal; prints boolean evidence only."""
import asyncio,json,time,datetime
from pathlib import Path
from aliyun_ocr_client import AliyunOCRClient

HERE=Path(__file__).resolve().parent
OUT=HERE.parents[1]/'reports/xiaohongshu/general-ocr/authentication.json'

async def main():
    report={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'cli_process_used':False,'sdk_credentials_version':'1.0.12'}
    try:
        config=json.loads((HERE/'config.json').read_text(encoding='utf-8'))['ocr']
        client=AliyunOCRClient(config)
        credential=await client.credentials.get_credential_async()
        report['provider']=credential.provider_name
        report['credential_complete']=bool(credential.access_key_id and credential.access_key_secret and credential.security_token)
        path=Path.home()/'.aliyun/config.json'
        before=json.loads(path.read_text(encoding='utf-8'))
        old=next(p for p in before['profiles'] if p['name']==config['profile'])
        report['mode']=old['mode']
        if old['mode']=='OAuth':
            # Simulate expiry only inside this provider, not in the profile file.
            inner=client.provider._CLIProfileCredentialsProvider__innerProvider
            inner._sts_expiration=0;inner._access_token_expire=0
            t=time.perf_counter()
            refreshed=await inner._refresh_credentials_async()
            report['refresh_ms']=round((time.perf_counter()-t)*1000)
            after=json.loads(path.read_text(encoding='utf-8'))
            new=next(p for p in after['profiles'] if p['name']==config['profile'])
            report['oauth_rotated']=new.get('oauth_refresh_token')!=old.get('oauth_refresh_token')
            report['sts_renewed']=new.get('access_key_id')!=old.get('access_key_id')
            report['persisted_sts_valid']=new.get('sts_expiration',0)>time.time()
            report['unrelated_profiles_preserved']=[p for p in before['profiles'] if p['name']!=config['profile']]==[p for p in after['profiles'] if p['name']!=config['profile']]
            # A fresh process/provider must load the persisted renewed credential.
            client=AliyunOCRClient(config)
        t=time.perf_counter();body=await client.call('DescribeUploadToken')
        report['direct_sdk_code']=body.get('Code')
        report['direct_sdk_ms']=round((time.perf_counter()-t)*1000)
        report['passed']=body.get('Code')==200 and report.get('persisted_sts_valid',True)
    except Exception as e:
        report.update(passed=False,error=getattr(e,'code',type(e).__name__))
    OUT.parent.mkdir(parents=True,exist_ok=True)
    OUT.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))

if __name__=='__main__':asyncio.run(main())
