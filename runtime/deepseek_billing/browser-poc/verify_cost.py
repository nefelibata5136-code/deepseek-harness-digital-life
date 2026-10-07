"""Host memory-only credential matching and exact official Decimal aggregation."""
import importlib.util
import json
from decimal import Decimal, localcontext, ROUND_DOWN
from pathlib import Path
import re
import sys
import os

HERE = Path(__file__).resolve().parent
LIVES = {'life-ca23d767-1b53-5adf-b85b-19bb81c72286':'persona',
         'life-f422ba76-d026-5363-83a1-552ea830106d':'new digital life'}
def run(value, operation=None):
    production=operation is None
    lives=LIVES
    saved=None
    if production:
        world=Path(os.environ.get('DL_WORLD_ROOT','.local/world'))
        settings=json.loads((world/'settings.json').read_text(encoding='utf-8'))
        saved=json.loads((world/'billing-identities.json').read_text(encoding='utf-8'))
        lives={row['lifeId']:saved[row['lifeId']]['name'] for row in settings['lives']}
        refs={row['lifeId']:row['keyEnv'] for row in settings['lives']}
        operation=lambda action,ref: {'value':os.environ[ref]}
    series=value['series']; start=value['start']; end=value['end']
    identities={}
    for row in series:
        key=row['api_key'];tracking=key['tracking_id'];masked=key['sensitive_id']
        if not re.fullmatch(r'[a-f0-9-]{36}',tracking) or not re.fullmatch(r'sk-[a-zA-Z0-9]+\*+[a-zA-Z0-9]+',masked):
            raise ValueError('UNSAFE_IDENTITY')
        if tracking in identities and identities[tracking]!=key:raise ValueError('IDENTITY_CONFLICT')
        identities[tracking]=key
    mappings={}
    for life,name in lives.items():
        ref=refs[life] if production else 'DL_LIFE_DEEPSEEK_'+life[5:].replace('-','_').upper()
        key=operation('resolve',ref)['value']
        matches=[]
        for tracking,identity in identities.items():
            masked=identity['sensitive_id'];prefix,suffix=masked.split('*')[0],masked.split('*')[-1]
            if len(key)==len(masked) and key.startswith(prefix) and key.endswith(suffix):matches.append(tracking)
        if len(matches)!=1 or identities[matches[0]]['name']!=name:raise ValueError('UNAMBIGUOUS_KEY_MAPPING_REQUIRED')
        if production:
            if saved[life]['tracking_id']!=matches[0]:raise ValueError('KEY_IDENTITY_CHANGED')
        mappings[life]=matches[0]
    if len(set(mappings.values()))!=len(mappings):raise ValueError('DISTINCT_IDENTITIES_REQUIRED')
    output=[]
    with localcontext() as ctx:
        ctx.prec=80
        for life,tracking in mappings.items():
            total=Decimal(0); models={};buckets=[]; seen=set()
            for row in series:
                if row['api_key']['tracking_id']!=tracking:continue
                model=row['model']
                if model in seen:raise ValueError('DUPLICATE_MODEL_SERIES')
                seen.add(model); subtotal=Decimal(0)
                for bucket in row['buckets']:
                    cost=bucket['cost'];timestamp=bucket['time']
                    if not isinstance(cost,str) or not re.fullmatch(r'\d+(?:\.\d+)?',cost):raise ValueError('INVALID_DECIMAL_COST')
                    if type(timestamp)!=int:raise ValueError('INVALID_BUCKET_TIME')
                    if start<=timestamp<end:
                        subtotal+=Decimal(cost);buckets.append({'model':model,'time':timestamp,'cost':cost})
                    elif Decimal(cost)!=0:raise ValueError('NONZERO_OUTSIDE_QUERY')
                models[model]=str(subtotal);total+=subtotal
            identity=identities[tracking]
            output.append({'life_id':life,'api_key_identity':{k:identity[k] for k in ['tracking_id','name','sensitive_id']},
                'mapping_verified':True,'mapping_method':'unique masked prefix/suffix and exact length matched to existing Host credential; expected official name corroborates',
                'today_cost_cny':str(total),'ui_rounded_cny':format(total.quantize(Decimal('0.01')),'f'),
                'official_ui_display_cny':format(total.quantize(Decimal('0.01'),rounding=ROUND_DOWN),'f'),
                'models':models,'buckets':buckets})
    return {'source':'deepseek_platform','start':start,'end':end,'tz':28800,'currency':'CNY','lives':output,'secrets_exported':False}

if __name__=='__main__':
    try:print(json.dumps(run(json.load(sys.stdin)),ensure_ascii=False))
    except Exception:
        print(json.dumps({'error':'OFFICIAL_COST_VERIFICATION_FAILED'}));sys.exit(1)
