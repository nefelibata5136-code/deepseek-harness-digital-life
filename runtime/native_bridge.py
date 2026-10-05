"""Tool transport for official DSH; no model, router or agent loop here."""
import contextlib,json,re,sys,uuid
from pathlib import Path
from file_tools import FileTools, BASE, WORKSPACE, SECRET, save_json, sanitize, now

def main():
    request=json.load(sys.stdin)
    if request.get('tool') in ('budget_check','usage','usage_start'):
        from usage_meter import budget_check,record_usage,usage_start
        result={'budget_check':budget_check,'usage':record_usage,'usage_start':usage_start}[request['tool']](request.get('arguments',{}))
        json.dump({'result':result},sys.stdout,ensure_ascii=False)
        return
    if request.get('tool') == 'terminal':
        from workspace_foundation.terminal_bridge import run_bound
        result = run_bound(request.get('arguments', {}), WORKSPACE)
        json.dump({'result': result}, sys.stdout, ensure_ascii=False)
        return
    session_id=request.get('session_id','native-persona')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,120}',session_id):raise ValueError('Invalid session identity')
    session=Path(__import__('os').environ.get('DL_DATA', '.local'))/'tool-sessions'/session_id
    session.mkdir(parents=True,exist_ok=True)
    if not (session/'state.json').exists():
        save_json(session/'state.json',{'created_at':now(),'purpose':'native DSH tool receipts only; no parallel model context',
                                      'tool_receipts_only':True})
    tools=FileTools(session, full_access=False)
    call_id=request.get('call_id') or 'native-'+uuid.uuid4().hex
    call={'id':call_id,'function':{'name':request['tool'],'arguments':json.dumps(request.get('arguments',{}),ensure_ascii=False)}}
    with contextlib.redirect_stdout(sys.stderr):
        try:result=tools.dispatch(call)
        except Exception as e:result={'error':type(e).__name__,'detail':sanitize(str(e))}
    json.dump({'result':result},sys.stdout,ensure_ascii=False)

if __name__=='__main__':
    sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
    try:main()
    except Exception as e:
        json.dump({'result':{'error':type(e).__name__,'detail':sanitize(str(e))}},sys.stdout,ensure_ascii=False)
