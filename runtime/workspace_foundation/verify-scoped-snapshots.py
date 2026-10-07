"""Scoped changes preserve siblings, exact bytes, exclusions, casing and recovery."""
import json, os, tempfile
from pathlib import Path
from snapshots import Versions

def verify():
    with tempfile.TemporaryDirectory(prefix='persona-scoped-') as root:
        ws=Path(root)/'workspace'; ws.mkdir(); v=Versions(ws,Path(root)/'versions')
        (ws/'MixedCase.md').write_bytes(b'dirty current baseline')
        (ws/'sibling.txt').write_bytes(b'unchanged')
        baseline=v.snapshot()
        # Real admission lowercases Windows keys, not Git entry names.
        key=str(ws/'MixedCase.md'); key=key.lower() if os.name=='nt' else key
        start=v.begin_file('a',key,'edit',os.getpid())
        assert start['files']==1 and start['scope']=='MixedCase.md'
        try:
            v.begin_file('b',key,'edit',os.getpid()); raise AssertionError('same file admitted')
        except RuntimeError: pass
        (ws/'MixedCase.md').write_bytes(b'after')
        sibling=v.begin_file('b',str(ws/'sibling.txt'),'write',os.getpid())
        (ws/'sibling.txt').write_bytes(b'parallel sibling')
        end=v.end_file(start['token'],'after-tool:edit')
        # This commit records A only, never prematurely claims B's in-flight bytes.
        assert v.git('show',end['commit']+':sibling.txt').stdout==b'unchanged'
        assert v.git('show',end['commit']+':MixedCase.md').stdout==b'after'
        assert len(v.tree(end['commit']))==2
        v.end_file(sibling['token'],'after-tool:write')
        assert v.git('show',v.head()+':sibling.txt').stdout==b'parallel sibling'
        (ws/'MixedCase.md').unlink()
        deleted=v.begin_file('a',key,'write',os.getpid())
        assert 'MixedCase.md' not in v.tree(deleted['commit'])
        (ws/'MixedCase.md').write_bytes(b'api_key='+b'X'*24)
        secret=v.end_file(deleted['token'],'after-tool:write')
        assert secret['excluded'][0]['reason']=='possible-secret-content'
        assert 'MixedCase.md' not in v.tree(secret['commit'])
        (ws/'MixedCase.md').write_bytes(b'new safe bytes')
        operation=v.begin_file('a',key,'edit',os.getpid())
        marker=v.store/'active-file-operations'/(operation['token']+'.json')
        item=json.loads(marker.read_text()); item['owner_pid']=2147483647
        marker.write_text(json.dumps(item))
        (ws/'external.txt').write_bytes(b'external change recovered')
        v.recover()
        assert v.git('show',v.head()+':external.txt').stdout==b'external change recovered'
        assert not v.file_markers()
        v.git('fsck','--full')
    return {'passed':True,'checks':['current-dirty-bytes','Windows-casing','local-scope','same-file-denied','different-file-parallel','sibling-preserved','delete','secret-excluded','interruption-full-recovery','git-fsck']}
if __name__=='__main__':print(json.dumps(verify()))
