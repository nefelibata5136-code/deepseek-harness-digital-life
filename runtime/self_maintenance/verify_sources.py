"""Offline source publisher invariants; synthetic files only, no real records."""
import json
from pathlib import Path
import tempfile
from publish_sources import publish, V1_EXACT, V1_EXTERNAL, collect

with tempfile.TemporaryDirectory(prefix='persona-source-check-') as folder:
    root=Path(folder);base=root/'source';workspace=root/'workspace'
    (base/'runtime/native_dsh/protected').mkdir(parents=True)
    (base/'README.md').write_text('Synthetic architecture map\n',encoding='utf-8')
    (base/'runtime/native_dsh/native-host.mjs').write_text('export const value=1;\n',encoding='utf-8')
    (base/'runtime/native_dsh/protected/private.json').write_text('synthetic private record',encoding='utf-8')
    first=publish(workspace,base);same=publish(workspace,base)
    assert first==same
    manifest=json.loads((Path(first['root'])/'manifest.json').read_text('utf-8'))
    assert not any('protected' in path for path in manifest['files'])
    assert len(list((workspace/'development/runtime-source').iterdir()))==2
    source=base/'runtime/native_dsh/native-host.mjs';source.write_text('export const value=2;\n',encoding='utf-8')
    second=publish(workspace,base);assert first['generation']!=second['generation']
    assert (Path(first['root'])/'runtime/native_dsh/native-host.mjs').read_text('utf-8')=='export const value=1;\n'
    copy=Path(second['root'])/'runtime/native_dsh/native-host.mjs';copy.write_text('local candidate edit',encoding='utf-8')
    try:publish(workspace,base)
    except ValueError as error:assert 'edited' in str(error)
    else:raise AssertionError('Edited snapshot overwritten')
    assert copy.read_text('utf-8')=='local candidate edit'
with tempfile.TemporaryDirectory(prefix='v1-source-check-') as folder:
    root=Path(folder);base=root/'source';workspace=root/'workspace';external=root/'external';external.mkdir()
    for name in V1_EXACT:
        path=base/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text('Synthetic source only\n',encoding='utf-8')
    for name in V1_EXTERNAL:
        (external/name).write_text('export const synthetic=true;\n',encoding='utf-8')
    (external/'connection.json').write_text('private synthetic connection',encoding='utf-8')
    (external/'policy.json').write_text('private synthetic policy',encoding='utf-8')
    generic=workspace/'development/runtime-source/CURRENT.json';generic.parent.mkdir(parents=True);generic.write_text('existing full snapshot pointer',encoding='utf-8')
    first=publish(workspace,base,scope='v1-capabilities',owner_life_id='life-one',external_root=external)
    same=publish(workspace,base,scope='v1-capabilities',owner_life_id='life-one',external_root=external)
    assert first==same and generic.read_text('utf-8')=='existing full snapshot pointer'
    manifest=json.loads(Path(first['manifest']).read_text('utf-8'))
    assert manifest['owner_life_id']=='life-one' and manifest['scope']=='v1-capabilities'
    assert not any(name.endswith(('connection.json','policy.json')) for name in manifest['files'])
    assert manifest['sourcePaths']['shared-source/persona-dots/bridge.mjs']==str(external/'bridge.mjs')
    assert manifest['sourcePaths']['runtime/native_dsh/multi-life/platform/official-search.mjs']==str(base/'runtime/native_dsh/multi-life/platform/official-search.mjs')
    assert 'shared-source/web-search/search.mjs' not in manifest['files']
    pointer=json.loads(Path(first['pointer']).read_text('utf-8'));assert pointer['root']==first['root']
    (external/'bridge.mjs').write_text('export const synthetic=false;\n',encoding='utf-8')
    newer=publish(workspace,base,scope='v1-capabilities',owner_life_id='life-one',external_root=external)
    assert newer['generation']!=first['generation']
    assert (Path(first['root'])/'shared-source/persona-dots/bridge.mjs').read_text('utf-8')=='export const synthetic=true;\n'
    (external/'slack.mjs').write_text('sk-'+('A'*25),encoding='utf-8')
    try:collect(base,'v1-capabilities',external)
    except ValueError as error:assert 'Possible secret' in str(error)
    else:raise AssertionError('Secret-shaped source accepted')
print(json.dumps({'passed':True,'checks':12,'externalRequests':0,'syntheticOnly':True}))
