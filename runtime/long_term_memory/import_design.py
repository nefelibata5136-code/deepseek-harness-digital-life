"""Translate Persona-authored decisions into stable entrances, preserving her text."""
import copy
import json
import uuid
from pathlib import Path
from source_reader import resolve_actor,digest,compact

def import_design(memory,design):
    design=Path(design)
    approved=design/'v1-approved.json'
    decisions=json.loads(approved.read_text('utf-8'))
    actor=resolve_actor(memory.base,authored_file=approved)
    if actor['kind']!='persona':raise PermissionError('Design acceptance must be authored by a top-level Persona Session')
    candidate_file=design/'candidates-v1.jsonl'
    candidate_actor=resolve_actor(memory.base,authored_file=candidate_file)
    if candidate_actor['kind']!='persona':raise PermissionError('Initial meaning layer must be authored by Persona')
    rows=[json.loads(line) for line in candidate_file.read_text('utf-8').splitlines() if line.strip()]
    candidates={r['event_id']:r for r in rows if r['event_id'].startswith('C')}
    accepted=decisions['accepted_aliases']
    if isinstance(accepted,dict):accepted=[a for a,v in accepted.items() if v.get('accepted') is True]
    if not isinstance(accepted,list) or len(set(accepted))!=len(accepted):raise ValueError('accepted_aliases must be a unique list/map')
    unit_map=decisions['units_by_alias']
    if isinstance(unit_map,list):unit_map={r['alias']:r['units'] for r in unit_map}
    correction_file=design/'v1-anchor-corrections.json'
    correction_actor=None
    if correction_file.exists():
        correction_actor=resolve_actor(memory.base,authored_file=correction_file)
        if correction_actor['kind']!='persona':raise PermissionError('Anchor corrections require Persona authorship')
        for c in json.loads(correction_file.read_text('utf-8'))['corrections']:
            matches=[u for u in unit_map[c['alias']] if u.get('unit_key',u.get('key'))==c['unit_key']]
            if len(matches)!=1:raise ValueError('Unknown anchor correction unit')
            matches[0]['original_source_ids']=copy.deepcopy(matches[0]['source_ids'])
            matches[0]['source_ids']=c['source_ids']
            matches[0]['anchor_correction']={'author':correction_actor,'fields':c,'file':str(correction_file)}
    fingerprint=digest(approved.read_bytes())
    if correction_actor:fingerprint=digest(approved.read_bytes()+correction_file.read_bytes())
    events,_,_=memory.project()
    ids={alias:'evt_'+str(uuid.uuid5(uuid.NAMESPACE_URL,actor['session_id']+'/persona-memory-design/'+alias)) for alias in candidates}
    registered=[];skipped=[];span_failures=[]
    prepared=[]
    for alias in accepted:
        row=copy.deepcopy(candidates[alias]);p=copy.deepcopy(row)
        p['alias']=alias;p.pop('event_id',None);p['import_fingerprint']=fingerprint
        p['design_origin']={'candidate_file':str(candidate_file),'candidate_sha256':digest(candidate_file.read_bytes()),
                            'decision_file':str(approved),'decision_sha256':fingerprint,'candidate_author':candidate_actor}
        p['time_note']='Source timestamp contains seconds; exact real occurrence/response-completion precision unknown. Old authored confidence retained as history.'
        if decisions.get('corrections'):p['engineering_review']=decisions['corrections']
        ns=row.get('source_namespace','local_runtime');conv=row.get('conversation_id','lagrange_main')
        main_refs=[memory.source_ref(ns,conv,i) for r in row.get('ranges',[]) for i in r['ids']]
        side_refs=[memory.source_ref(ns,r['conversation_id'],i) for r in row.get('side_channel',[]) for i in r['ids']]
        units=[]
        for source_unit in unit_map[alias]:
            u=copy.deepcopy(source_unit)
            u['key']=u.get('key',u.get('unit_key'))
            uconv=u.get('source_conversation',conv)
            uns=u.get('source_namespace',ns)
            anchors=u.get('anchors',u.get('anchor'))
            # Accept the concise author format; anchors belong to an actual
            # source message and are verified exactly, never invented.
            if isinstance(anchors,list):anchors_by_id={str(a.get('id',a.get('message_id'))):a for a in anchors}
            elif isinstance(anchors,dict):anchors_by_id={str(anchors.get('id',anchors.get('message_id',u.get('source_ids',[None])[0]))):anchors}
            else:anchors_by_id={}
            if u.get('anchor_start'):
                anchors_by_id[str(u.get('anchor_id',u['source_ids'][0]))]={'start':u['anchor_start'],'end':u.get('anchor_end')}
            refs=[]
            source_ids=u['source_ids']
            if source_ids and isinstance(source_ids[0],dict):
                refs=[]
                for group in source_ids:
                    gns=group.get('namespace',ns);gc=group.get('conversation_id',conv);ids_in=group['ids'];a=group.get('anchor')
                    for j,i in enumerate(ids_in):
                        anchor=None
                        if a:
                            anchor={'start':a.get('start_quote') if j==0 else None,'end':a.get('end_quote') if j==len(ids_in)-1 else None}
                        try:ref=memory.source_ref(gns,gc,i,anchor)
                        except ValueError as e:
                            span_failures.append({'alias':alias,'key':u['key'],'id':i,'error':str(e)});continue
                        refs.append(ref)
                        collection=side_refs if u.get('channel')=='test' or gc=='lagrange_test' else main_refs
                        if ref['mid'] not in {r['mid'] for r in collection}:collection.append(memory.source_ref(gns,gc,i))
                u['refs']=refs;units.append(u);continue
            for i in source_ids:
                raw_anchor=anchors_by_id.get(str(i))
                anchor={'start':raw_anchor.get('start',raw_anchor.get('anchor_start')),'end':raw_anchor.get('end',raw_anchor.get('anchor_end'))} if raw_anchor else None
                try:ref=memory.source_ref(uns,uconv,i,anchor)
                except ValueError as e:
                    span_failures.append({'alias':alias,'key':u['key'],'id':i,'error':str(e)});continue
                refs.append(ref)
                collection=side_refs if u.get('channel')=='test' or uconv=='lagrange_test' else main_refs
                if ref['mid'] not in {r['mid'] for r in collection}:collection.append(memory.source_ref(uns,uconv,i))
            u['refs']=refs
            units.append(u)
        p['source_refs']=main_refs;p['side_refs']=side_refs;p['units']=units
        prepared.append((alias,p))
    if span_failures:raise ValueError('Author anchors need review before any import writes: '+compact(span_failures))
    for alias,p in prepared:
        eid=ids[alias]
        if eid in events and events[eid].get('import_fingerprint')==fingerprint:
            skipped.append(alias);continue
        result=memory.register(p,candidate_actor,eid,events[eid]['revision'] if eid in events else None)
        memory.decide(eid,'accepted',actor,result['revision'])
        registered.append(alias)
    # Author's thread/relationship names stay free text; repeated import doesn't
    # append duplicate decisions, links, or notes.
    if registered:
        for r in decisions.get('relations',[]):
            if r.get('from_alias') not in accepted or r.get('to_alias') not in accepted:continue
            memory.append('relation',{'from_event':ids[r['from_alias']],'to_event':ids[r['to_alias']],'relation':r['relation']},actor)
        threads=decisions.get('threads',[])
        if isinstance(threads,dict):threads=[{'thread_id':key,**value} for key,value in threads.items()]
        for thread in threads:
            members=thread.get('members',thread.get('event_aliases',[]))
            memory.append('thread',{**thread,'thread_id':thread.get('thread_id',thread.get('id',thread.get('alias',thread.get('name')))),
                         'members':[ids[a] for a in members if a in accepted]},actor)
    recall_updates=apply_recall(memory,design)
    memory.export_catalog()
    return {'registered':registered,'skipped':skipped,'ids':{a:ids[a] for a in accepted},'decision_author':actor,
            'queries':decisions.get('queries',[]),'recall_updates':recall_updates,'raw_source_truth':'original chat only; meaning retains author provenance'}

def apply_recall(memory,design):
    path=Path(design)/'v1-recall-additions.json'
    if not path.exists():return {'updated':[]}
    actor=resolve_actor(memory.base,authored_file=path)
    if actor['kind']!='persona':raise PermissionError('Recall additions require native top-level Persona authorship')
    fingerprint=digest(path.read_bytes());document=json.loads(path.read_text('utf-8'))
    grouped={}
    for update in document['units']:grouped.setdefault(update['alias'],[]).append(update)
    updated=[];skipped=[];prepared=[]
    for alias,updates in grouped.items():
        event=memory.event(alias)
        if event.get('recall_addition_fingerprint')==fingerprint:skipped.append(alias);continue
        if event['status']!='accepted' or event['needs_review']:raise ValueError('Recall changes require accepted/current source; Persona must review changed originals first')
        for update in updates:
            units=[u for u in event['units'] if u['key']==update['unit_key']]
            if len(units)!=1:raise ValueError('Recall addition references unknown/ambiguous unit')
            unit=units[0]
            for field in ('terms','my_phrases'):
                values=update.get(field,[])
                if not isinstance(values,list) or any(not isinstance(v,str) for v in values):raise ValueError('Recall additions must be authored strings')
                unit[field]=list(dict.fromkeys(unit.get(field,[])+values))
            if update.get('blurb') is not None:unit['blurb']=update['blurb']
            unit['recall_additions']={'fields':update,'actor':actor,'file_sha256':fingerprint}
            memory.entrance_text(event,unit)
        event['recall_addition_fingerprint']=fingerprint
        event['recall_revision_origin']={'file':str(path),'sha256':fingerprint,'actor':actor,'document':document}
        prepared.append((alias,event))
    for alias,event in prepared:
        ids=[u['memory_id'] for u in event['units']]
        result=memory.register(event,actor,event['event_id'],event['revision'])
        memory.decide(event['event_id'],'accepted',actor,result['revision'])
        assert [u['memory_id'] for u in memory.event(alias)['units']]==ids
        updated.append(alias)
    return {'updated':updated,'skipped':skipped,'source_file':str(path),'native_author':actor}
