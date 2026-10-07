"""Compare official Slack query transport for one public test thread; no sends."""
import json
import sys
import importlib.util
import urllib.parse
import urllib.request
from configure_slack import CREDENTIALS
spec=importlib.util.spec_from_file_location('broker',CREDENTIALS)
broker=importlib.util.module_from_spec(spec);spec.loader.exec_module(broker)
opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:7897'}))
thread=sys.argv[1] if len(sys.argv)>1 else '1791183014.804549'
if not __import__('re').fullmatch(r'\d+\.\d+',thread):raise ValueError('INVALID_THREAD')
for ref in ['DL_DOTS_SLACK_TOKEN']:
    record=broker.operation('resolve',ref)
    query=urllib.parse.urlencode({'channel':'UNCONFIGURED_ACCOUNT','ts':thread,'limit':15})
    for mode in ['GET','POST_FORM']:
        request=urllib.request.Request('https://slack.com/api/conversations.replies'+('?' + query if mode=='GET' else ''),
          data=None if mode=='GET' else query.encode(),headers={'Authorization':'Bearer '+record['value'],
          'Content-Type':'application/x-www-form-urlencoded; charset=utf-8'})
        try:
            with opener.open(request,timeout=8) as response:
                data=json.loads(response.read(2097152));scopes=response.headers.get('x-oauth-scopes')
            print(json.dumps({'reference':ref,'mode':mode,'ok':data.get('ok'),'error':data.get('error'),
              'scopes':scopes,'messages':[{'user':m.get('user'),'ts':m.get('ts'),'bot_id':m.get('bot_id'),'thread_ts':m.get('thread_ts'),
              'text':m.get('text','')[:600]} for m in data.get('messages',[])]},ensure_ascii=False))
        except Exception:
            print(json.dumps({'reference':ref,'mode':mode,'code':'BOUNDED_REPLY_READ_FAILED'}))
