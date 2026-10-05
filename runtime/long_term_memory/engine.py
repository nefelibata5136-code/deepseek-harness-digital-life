"""Persona's source-grounded entrances, append-only authorship and rebuildable cache.

Event boundaries and recall text are authored by Persona; this engine never
segments chats by time, message count, or character length.
"""
from __future__ import annotations
import copy
import json
import math
import os
import re
import sqlite3
import uuid
from pathlib import Path
from contextlib import contextmanager
from datetime import datetime,timezone
from source_reader import compact,digest,message_key,snapshot,verify_current,anchor_span,SourceConflict
from qwen import Qwen,safe_text,SECRET

HERE=Path(__file__).resolve().parent
BASE=HERE.parents[1]
def now():return datetime.now(timezone.utc).isoformat()
def atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with temp.open('x',encoding='utf-8') as f:
        f.write(json.dumps(value,ensure_ascii=False,indent=2)+'\n');f.flush();os.fsync(f.fileno())
    os.replace(temp,path)

class Memory:
    def __init__(self,base=BASE,store=None,sources=None,config=None,client_factory=Qwen):
        self.base=Path(base)
        self.store=Path(store or Path(os.environ.get('DL_DATA', '.local'))/'memory-store')
        self.store.mkdir(parents=True,exist_ok=True)
        self.sources=sources or json.loads((HERE/'sources.json').read_text('utf-8'))
        self.config=config or json.loads((HERE/'config.json').read_text('utf-8'))
        self.factory=client_factory
        self.db_path=self.store/'index.sqlite3'
        self.journal=self.store/'journal.jsonl'
        self.observations=self.store/'source-observations.jsonl'
        self.export=Path(self.sources['workspace'])/'memory/retrieval'
        self.client=None
        self._db=None

    @contextmanager
    def lock(self):
        path=self.store/'writer.lock'
        with path.open('a+b') as f:
            if f.tell()==0:f.write(b'0');f.flush()
            f.seek(0)
            if os.name=='nt':
                import msvcrt
                try:msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
                except OSError:raise RuntimeError('Memory writer busy; retry only after current operation completes') from None
            else:
                import fcntl
                fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            try:yield
            finally:
                f.seek(0)
                if os.name=='nt':msvcrt.locking(f.fileno(),msvcrt.LK_UNLCK,1)
                else:fcntl.flock(f,fcntl.LOCK_UN)

    @property
    def db(self):
        if self._db is None:
            self._db=sqlite3.connect(self.db_path,timeout=5)
            self._db.row_factory=sqlite3.Row
            self._db.execute('PRAGMA synchronous=FULL')
            self._db.executescript('''
            CREATE TABLE IF NOT EXISTS messages(mid TEXT PRIMARY KEY,item TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE IF NOT EXISTS versions(mid TEXT NOT NULL,hash TEXT NOT NULL,item TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(mid,hash));
            CREATE TABLE IF NOT EXISTS vectors(cache_key TEXT PRIMARY KEY,vector TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS reranks(cache_key TEXT PRIMARY KEY,result TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            ''')
        return self._db

    def close(self):
        if self._db:self._db.close();self._db=None

    def ledger(self):
        rows=[];previous='0'*64
        if not self.journal.exists():return rows
        data=self.journal.read_bytes()
        if data and not data.endswith(b'\n'):raise RuntimeError('Incomplete journal tail; preserve it and inspect before recovery')
        for line in data.decode('utf-8').splitlines():
            entry=json.loads(line);h=entry.pop('hash')
            if entry['seq']!=len(rows) or entry['previous']!=previous or digest(compact(entry))!=h:raise RuntimeError('Journal integrity failed; do not auto overwrite authored decisions')
            entry['hash']=h;rows.append(entry);previous=h
        return rows

    def append(self,operation,payload,actor):
        safe_text(compact(payload))
        rows=self.ledger()
        entry={'seq':len(rows),'previous':rows[-1]['hash'] if rows else '0'*64,'recorded_at':now(),
               'operation':operation,'payload':payload,'actor':actor}
        entry['hash']=digest(compact(entry))
        with self.journal.open('ab') as f:f.write((compact(entry)+'\n').encode());f.flush();os.fsync(f.fileno())
        return entry

    def project(self):
        events={};relations=[];threads={}
        for entry in self.ledger():
            p=copy.deepcopy(entry['payload']);op=entry['operation']
            if op=='event':
                p['annotations']=events.get(p['event_id'],{}).get('annotations',[])
                p['revision']=events.get(p['event_id'],{}).get('revision',0)+1
                p['authorship']=entry['actor'];p['recorded_at']=entry['recorded_at'];events[p['event_id']]=p
            elif op=='status':
                event=events[p['event_id']];event['status']=p['status'];event['accepted_hashes']=p.get('accepted_hashes',event.get('accepted_hashes',{}))
                if p.get('ref_updates'):
                    event['source_refs']=p['ref_updates']['source_refs'];event['side_refs']=p['ref_updates']['side_refs'];event['units']=p['ref_updates']['units']
                event['revision']+=1;event['decision_actor']=entry['actor'];event['decision_at']=entry['recorded_at']
            elif op=='annotation':
                event=events[p['event_id']];event['annotations'].append({**p,'actor':entry['actor'],'recorded_at':entry['recorded_at']});event['revision']+=1
            elif op=='relation':relations.append({**p,'actor':entry['actor'],'recorded_at':entry['recorded_at']})
            elif op=='thread':threads[p['thread_id']]=p
        for event in events.values():
            problems=[]
            for mid,h in event.get('accepted_hashes',{}).items():
                row=self.db.execute('SELECT item,deleted FROM messages WHERE mid=?',(mid,)).fetchone()
                if row is None or row['deleted'] or json.loads(row['item'])['revision_hash']!=h:problems.append(mid)
            event['needs_review']=bool(problems);event['changed_source_keys']=problems
        return events,relations,threads

    def sync(self):
        try:current=snapshot(self.base,self.sources)
        except SourceConflict as e:
            atomic_json(self.store/'source-conflicts.json',{'observed_at':now(),'pairs':e.pairs});raise
        old={r['mid']:r for r in self.db.execute('SELECT * FROM messages')}
        changed=[];added=[];deleted=[]
        stamp=now()
        observations=[]
        for mid,item in current.items():
            before=json.loads(old[mid]['item']) if mid in old else None
            if before is None or old[mid]['deleted'] or before['revision_hash']!=item['revision_hash']:
                (added if before is None else changed).append(mid)
                observations.append({'mid':mid,'observed_at':stamp,'item':item,'deleted':False})
                self.db.execute('INSERT OR IGNORE INTO versions VALUES(?,?,?,?)',(mid,item['revision_hash'],compact(item),stamp))
            self.db.execute('INSERT OR REPLACE INTO messages VALUES(?,?,0)',(mid,compact(item)))
        for mid,row in old.items():
            if mid not in current and not row['deleted']:
                deleted.append(mid);self.db.execute('UPDATE messages SET deleted=1 WHERE mid=?',(mid,))
                observations.append({'mid':mid,'observed_at':stamp,'item':json.loads(row['item']),'deleted':True})
        # Raw-version observations survive losing the SQLite cache. They are
        # timestamped source snapshots, not invented or normalized conversations.
        if observations:
            with self.observations.open('ab') as f:
                for obs in observations:f.write((compact(obs)+'\n').encode())
                f.flush();os.fsync(f.fileno())
        self.db.execute('INSERT OR REPLACE INTO state VALUES(?,?)',('last_sync',stamp));self.db.commit()
        if (changed or deleted) and self.journal.exists():self.export_catalog()
        return {'message_count':len(current),'added':added,'changed':changed,'deleted':deleted,'observed_at':stamp,
                'segmentation':'none; changes enter pending review, not automatically accepted events'}

    def item(self,mid,version=None):
        if version:row=self.db.execute('SELECT item FROM versions WHERE mid=? AND hash=?',(mid,version)).fetchone()
        else:
            row=self.db.execute('SELECT item,deleted FROM messages WHERE mid=?',(mid,)).fetchone()
            if row is not None and row['deleted']:raise ValueError('Raw record deleted; historical version available explicitly')
        if row is None:raise ValueError('Unknown raw message key: '+mid)
        return json.loads(row['item'])

    def source_ref(self,namespace,conversation,record_id,anchor=None):
        mid=message_key(namespace,conversation,record_id);item=self.item(mid)
        ref={'mid':mid,'namespace':namespace,'conversation_id':conversation,'record_id':record_id,
             'revision_hash':item['revision_hash'],'content_hash':item['content_hash']}
        if anchor:ref['span']=anchor_span(item['raw']['content'],anchor['start'],anchor.get('end'))
        return ref

    def entrance_text(self,event,unit):
        # Use only this semantic entrance, not every term on the entire event.
        text='\n'.join([event['name'],unit.get('title',''),unit.get('blurb',event.get('one_line','')),
             '时间（原记录）: '+compact(event.get('time',{})),
             '检索词: '+'、'.join(unit.get('terms',[])),
             '我的说法（署名入口）: '+'、'.join(unit.get('my_phrases',[]))])
        safe_text(text)
        if len(text.encode())>4000:raise ValueError(f'Entrance oversized ({len(text)} Unicode chars / {len(text.encode())} UTF-8 bytes; limit 4000 bytes); revise its meaning-based wording, never silently slice')
        return text

    def register(self,payload,actor,event_id=None,expected_revision=None):
        events,_,_=self.project()
        p=copy.deepcopy(payload)
        event_id=event_id or 'evt_'+str(uuid.uuid4())
        if event_id in events:
            if expected_revision!=events[event_id]['revision']:raise ValueError('Stale event revision; read versions before editing')
            if actor['kind']!='persona':raise PermissionError('Child suggestions cannot change an existing event')
            p.setdefault('meaning_provenance',events[event_id].get('meaning_provenance',events[event_id]['authorship']))
        p['event_id']=event_id;p['status']='candidate'
        if actor['kind']!='persona':
            # Suggestions retain their words as suggested meaning, never as
            # Persona's signed interpretation until she explicitly authors it.
            p['suggested_meaning']=p.pop('meaning',{})
            for u in p.get('units',[]):u['suggested_my_phrases']=u.pop('my_phrases',[])
            p['my_phrases']=[]
        if not p.get('name') or not p.get('source_refs') or not p.get('units'):raise ValueError('Event needs a name, exact source_refs and semantic units')
        all_keys={r['mid'] for r in p['source_refs']+p.get('side_refs',[])}
        for ref in p['source_refs']+p.get('side_refs',[]):
            if self.item(ref['mid'])['revision_hash']!=ref['revision_hash']:raise ValueError('Source changed; reread before proposing')
        keys=[]
        for unit in p['units']:
            if not unit.get('key') or unit['key'] in keys:raise ValueError('Each entrance needs a unique author-selected key')
            keys.append(unit['key'])
            if not unit.get('refs') or any(r['mid'] not in all_keys for r in unit['refs']):raise ValueError('Entrance must map to event source or its explicit side evidence')
            unit['memory_id']='mem_'+str(uuid.uuid5(uuid.NAMESPACE_URL,event_id+'/'+unit['key']))
            for ref in unit['refs']:
                item=self.item(ref['mid'])
                if ref.get('span'):
                    span=ref['span'];content=item['raw']['content']
                    if content[span['start']:span['end']]!=span['exact_quote'] or digest(content)!=span['content_hash']:raise ValueError('Span does not match raw Unicode source')
            unit['recall_text']=self.entrance_text(p,unit)
        p['accepted_hashes']={}
        self.append('event',p,actor)
        return {'event_id':event_id,'revision':self.project()[0][event_id]['revision'],'status':'candidate'}

    def decide(self,event_id,status,actor,expected_revision):
        if actor['kind']!='persona':raise PermissionError('Only a native top-level Persona Session can accept/withdraw memory')
        event=self.event(event_id)
        if event['revision']!=expected_revision:raise ValueError('Stale event revision; inspect first')
        if status not in ('accepted','candidate','withdrawn','rejected'):raise ValueError('Unknown decision state')
        hashes={r['mid']:self.item(r['mid'])['revision_hash'] for r in event['source_refs']+event.get('side_refs',[])}
        updates=None
        if status=='accepted':
            updates=copy.deepcopy({k:event.get(k,[]) for k in ('source_refs','side_refs','units')})
            refs=updates['source_refs']+updates['side_refs']+[r for u in updates['units'] for r in u['refs']]
            for ref in refs:
                item=self.item(ref['mid']);ref['revision_hash']=item['revision_hash'];ref['content_hash']=item['content_hash']
                if ref.get('span'):ref['span']=anchor_span(item['raw']['content'],ref['span']['start_anchor'],ref['span'].get('end_anchor'))
        entry=self.append('status',{'event_id':event['event_id'],'status':status,'accepted_hashes':hashes,'ref_updates':updates},actor)
        return {'event_id':event['event_id'],'status':status,'revision':event['revision']+1,'journal_seq':entry['seq']}

    def annotate(self,event_id,fields,actor,expected_revision,supersedes=None):
        if actor['kind']!='persona':raise PermissionError('Child suggestions cannot write Persona meaning/tags/notes')
        event=self.event(event_id)
        if event['revision']!=expected_revision:raise ValueError('Stale event revision')
        if supersedes and supersedes not in {a['annotation_id'] for a in event['annotations']}:raise ValueError('Correction target does not exist on this event')
        annotation_id='ann_'+str(uuid.uuid4())
        entry=self.append('annotation',{'event_id':event['event_id'],'annotation_id':annotation_id,'fields':fields,'supersedes':supersedes},actor)
        return {'event_id':event['event_id'],'annotation_id':annotation_id,'revision':event['revision']+1,'journal_seq':entry['seq']}

    def event(self,event_id):
        events,_,_=self.project()
        matches=[e for e in events.values() if event_id in (e['event_id'],e.get('alias'))]
        if len(matches)!=1:raise ValueError('Unknown/ambiguous event ID or alias')
        return matches[0]

    def api_audit(self,record):
        row={**record,'observed_at':now()}
        with (self.store/'api-requests.jsonl').open('ab') as f:f.write((compact(row)+'\n').encode());f.flush();os.fsync(f.fileno())

    def provider(self):
        if self.client is None:self.client=self.factory(self.config,self.api_audit)
        return self.client

    def vector_key(self,text):return digest(compact([self.config['workspace_id'],self.config['embedding_model'],self.config['dimension'],text]))
    def vectors(self,texts):
        unique=list(dict.fromkeys(texts));cached={}
        for text in unique:
            row=self.db.execute('SELECT vector FROM vectors WHERE cache_key=?',(self.vector_key(text),)).fetchone()
            if row is not None:
                try:
                    vector=json.loads(row['vector'])
                    if len(vector)!=self.config['dimension'] or not all(isinstance(x,(int,float)) and math.isfinite(x) for x in vector) or not any(vector):raise ValueError()
                    cached[text]=vector
                except (ValueError,TypeError):
                    self.db.execute('DELETE FROM vectors WHERE cache_key=?',(self.vector_key(text),))
        pending=[t for t in unique if t not in cached]
        for start in range(0,len(pending),10):
            batch=pending[start:start+10];values=self.provider().embed(batch)
            for text,vector in zip(batch,values):
                self.db.execute('INSERT OR REPLACE INTO vectors VALUES(?,?)',(self.vector_key(text),compact(vector)));cached[text]=vector
            self.db.commit()
        return [cached[t] for t in texts]

    def embed(self,max_units=100,event_ids=None):
        events,_,_=self.project()
        selected={self.event(e)['event_id'] for e in event_ids} if event_ids is not None else None
        texts=[u['recall_text'] for e in events.values() if e['status']=='accepted' and not e['needs_review'] and (selected is None or e['event_id'] in selected) for u in e['units']]
        if len(texts)>max_units:raise ValueError('Explicit build unit bound exceeded; select batch, do not truncate')
        before=self.db.execute('SELECT count(*) FROM vectors').fetchone()[0]
        self.vectors(texts) if texts else None
        return {'entrances':len(texts),'new_vectors':self.db.execute('SELECT count(*) FROM vectors').fetchone()[0]-before,'raw_chat_sent':False}

    def tags(self,event):
        tags=set(event.get('tags',[]))
        for a in event['annotations']:
            tags.update(a['fields'].get('tags',[]));tags.difference_update(a['fields'].get('remove_tags',[]))
        return sorted(tags)

    def search(self,query,limit=None,candidates=None,include_test=False,tags=None,speaker=None,from_time=None,to_time=None):
        safe_text(query)
        # Omitted tool/CLI arguments follow config; explicit arguments override it.
        # Keep legacy defaults for fixtures/configurations predating these keys.
        limit=self.config.get('default_results',5) if limit is None else limit
        candidates=self.config.get('default_candidates',30) if candidates is None else candidates
        if type(limit) is not int or type(candidates) is not int or not 1<=limit<=10 or not 1<=candidates<=30:
            raise ValueError('Result limit 1..10; candidates 1..30')
        events,relations,threads=self.project()
        units=[]
        for e in events.values():
            if e['status']!='accepted' or e['needs_review']:continue
            if tags and not set(tags).issubset(self.tags(e)):continue
            if speaker and speaker not in compact(e.get('speakers',[])):continue
            if from_time and str(e.get('time',{}).get('end',''))<from_time:continue
            if to_time and str(e.get('time',{}).get('start',''))>to_time:continue
            for u in e['units']:
                if u.get('channel')=='test' and not include_test:continue
                units.append((e,u))
        if not units:return {'query':query,'results':[],'notice':'No accepted/current entries match filters; no conclusion about all historical chats'}
        missing=sum(self.db.execute('SELECT 1 FROM vectors WHERE cache_key=?',(self.vector_key(u['recall_text']),)).fetchone() is None for _,u in units)
        if missing>100:raise ValueError('More than 100 unbuilt entrances; maintainer must explicitly embed a selected batch before search')
        vectors=self.vectors([query]+[u['recall_text'] for _,u in units]);q=vectors[0]
        norm=lambda v:math.sqrt(sum(x*x for x in v))
        ranked=sorted([(sum(a*b for a,b in zip(q,v))/(norm(q)*norm(v)),e,u) for (e,u),v in zip(units,vectors[1:])],key=lambda r:(-r[0],r[2]['memory_id']))[:candidates]
        texts=[u['recall_text'] for _,_,u in ranked]
        cache_key=digest(compact([self.config['rerank_model'],self.config['workspace_id'],query,texts]))
        row=self.db.execute('SELECT result FROM reranks WHERE cache_key=?',(cache_key,)).fetchone()
        cached=row is not None
        try:
            order=json.loads(row['result']) if row else None
            if not isinstance(order,list) or len(order)!=len(texts) or {r['index'] for r in order}!=set(range(len(texts))) or not all(isinstance(r['score'],(int,float)) and math.isfinite(r['score']) for r in order):raise ValueError()
        except (ValueError,TypeError,KeyError):order=None;cached=False
        if order is None:
            order=self.provider().rerank(query,texts)
            self.db.execute('INSERT OR REPLACE INTO reranks VALUES(?,?)',(cache_key,compact(order)));self.db.commit()
        grouped={}
        for rank in order:
            cosine,e,u=ranked[rank['index']]
            hit={'memory_id':u['memory_id'],'entrance_key':u['key'],'title':u.get('title'),
                 'blurb':u.get('blurb'),'source_refs':[{k:v for k,v in ref.items() if k!='span'}|({'local_span':{k:v for k,v in ref['span'].items() if k!='exact_quote'}} if ref.get('span') else {}) for ref in u['refs']],
                 'channel':u.get('channel','main'),'keyword_matches':[],
                 'semantic_hint':{'embedding_cosine':cosine,'rerank_score':rank['score'],'model':self.config['rerank_model'],'interpretation':'model relevance hint, not a factual explanation'},'model_explanation':None}
            for field in ('terms','my_phrases'):
                for value in u.get(field,[]):
                    if query in value or (len(value)>1 and value in query):hit['keyword_matches'].append({'field':field,'text':value,'basis':'literal substring in entrance, not original-source quotation'})
            eid=e['event_id']
            if eid not in grouped:
                grouped[eid]={'event_id':eid,'alias':e.get('alias'),'name':e['name'],'one_line':e.get('one_line'),
                  'time':e.get('time'),'time_note':e.get('time_note'),'speakers':e.get('speakers',[]),
                  'tags':self.tags(e),'doubts':e.get('doubts',[]),'missing':e.get('missing',[]),
                  'authored_note':{'text':e.get('meaning',{}).get('then'),'author':e.get('meaning_provenance',e['authorship'])['kind'],'written_at':e.get('meaning_provenance',e['authorship']).get('recorded_at'),'indexed_at':e['recorded_at'],'kind':'Persona retrospective note; direct source opened separately'},
                  'matching_entrances':[],'threads':[t for t in threads.values() if eid in t['members']],
                  'open_views':['summary','local','event','message','relations','versions','source_compare'],'raw_content_included':False}
            grouped[eid]['matching_entrances'].append(hit)
        audit_id='search_'+cache_key
        audit={'search_id':audit_id,'query':query,'ranked_entrances':[{'event_id':ranked[r['index']][1]['event_id'],'alias':ranked[r['index']][1].get('alias'),'memory_id':ranked[r['index']][2]['memory_id'],'key':ranked[r['index']][2]['key'],'embedding_cosine':ranked[r['index']][0],'rerank_score':r['score']} for r in order]}
        atomic_json(self.store/'searches'/(audit_id+'.json'),audit)
        return {'query':query,'search_id':audit_id,'results':list(grouped.values())[:limit],'candidate_entrances':len(ranked),'rerank_cache_hit':cached,
                'coverage':'Accepted V1 subset only; unrelated records remain unorganized','includes_test':include_test,'raw_content_included':False}

    def paginate(self,text,offset=0,limit=6000):
        if not isinstance(offset,int) or offset<0 or not 1<=limit<=20000:raise ValueError('offset >=0, page limit 1..20000')
        safe_text(text)
        end=min(offset+limit,len(text))
        return {'text':text[offset:end],'offset':offset,'next_offset':end if end<len(text) else None,'total_chars':len(text),'offset_unit':'Unicode code points','complete':end>=len(text)}

    def open(self,event_id=None,view='summary',memory_id=None,record_id=None,namespace='local_runtime',conversation='lagrange_main',offset=0,limit=6000,include_test=False,version=None,search_id=None):
        if view=='source_conflicts':return self.paginate((self.store/'source-conflicts.json').read_text('utf-8'),offset,limit)
        if view=='search_audit':
            if not search_id or not re.fullmatch(r'search_[a-f0-9]{64}',search_id):raise ValueError('Use the returned search_id')
            return self.paginate((self.store/'searches'/(search_id+'.json')).read_text('utf-8'),offset,limit)
        event=self.event(event_id) if event_id else None
        if event is None and view not in ('message','source_compare'):raise ValueError('event_id required for this view')
        if view=='summary':
            result={k:v for k,v in event.items() if k not in ('units','accepted_hashes')}
            result['tags']=self.tags(event);result['summary_author']='persona';result['summary_kind']='current authored view with historical notes separately preserved'
            return self.paginate(json.dumps(result,ensure_ascii=False,indent=2),offset,limit)
        if view=='versions':
            authored=[r for r in self.ledger() if r['payload'].get('event_id')==event['event_id']]
            return self.paginate(json.dumps({'event_id':event['event_id'],'current_annotations':event['annotations'],'complete_authored_versions':authored,'note':'Old and new complete wording retained; supersedes links do not replace old text'},ensure_ascii=False,indent=2),offset,limit)
        if view=='relations':
            events,relations,threads=self.project();eid=event['event_id']
            linked=[r for r in relations if eid in (r.get('from_event'),r.get('to_event'))]
            return {'event_id':eid,'relations':linked,'threads':[t for t in threads.values() if eid in t['members']],
                    'linked_events':[{'event_id':e['event_id'],'alias':e.get('alias'),'name':e['name']} for e in events.values() if any(e['event_id'] in (r.get('from_event'),r.get('to_event')) for r in linked)]}
        if view=='source_compare':
            if record_id is None:raise ValueError('record_id required for source comparison')
            items=[]
            for ns in ('local_runtime','vps_20260724'):
                try:item=self.item(message_key(ns,conversation,record_id));items.append(item)
                except ValueError:continue
            if not items:raise ValueError('No raw records available for this id')
            result={'same_revision':len(items)==2 and items[0]['revision_hash']==items[1]['revision_hash'],
                    'same_content':len(items)==2 and items[0]['content_hash']==items[1]['content_hash'],'sources':[{**i,'current_locator':verify_current(i)} for i in items]}
            return self.paginate(json.dumps(result,ensure_ascii=False,indent=2),offset,limit)
        refs=event['source_refs']+(event.get('side_refs',[]) if include_test else []) if event else []
        if view=='local':
            units=[u for u in event['units'] if memory_id in (u['memory_id'],u['key'])]
            if len(units)!=1:raise ValueError('Local read requires the returned memory_id/entrance key')
            if units[0].get('channel')=='test' and not include_test:raise ValueError('Test side evidence requires include_test=true')
            refs=units[0]['refs']
        elif view=='message':
            if record_id is None:raise ValueError('record_id required')
            mid=message_key(namespace,conversation,record_id)
            refs=[{'mid':mid}]
        elif view!='event':raise ValueError('Unknown open view')
        parts=[];mapping=[]
        for ref in refs:
            item=self.item(ref['mid'],version)
            locator=verify_current(item) if not version else {'source':'historical observed snapshot','revision_hash':item['revision_hash']}
            raw=item['raw'];content=raw['content']
            if view=='local' and ref.get('span'):
                span=ref['span']
                if digest(content)!=span['content_hash']:span=anchor_span(content,span['start_anchor'],span.get('end_anchor'))
                content=content[span['start']:span['end']]
            start=sum(len(p) for p in parts)
            text=f"\n[{item['namespace']} / {item['conversation']} / id={item['record_id']} / role={raw['role']} / created_at={raw.get('created_at')} / occurrence_precision=unknown]\n{content}\n"
            parts.append(text);mapping.append({'start':start,'end':start+len(text),'mid':item['mid'],'locator':locator,'content_hash':item['content_hash'],'source_role_is_not_speaker':True})
        return {**self.paginate(''.join(parts),offset,limit),'event_id':event['event_id'] if event else None,'view':view,'source_mapping':mapping,'needs_review':event['needs_review'] if event else None}

    def pending(self,offset=0,limit=20,namespace=None,conversation=None):
        if offset<0 or not 1<=limit<=100:raise ValueError('Invalid pending page')
        events,_,_=self.project();assigned={r['mid'] for e in events.values() for r in e['source_refs']+e.get('side_refs',[])}
        items=[]
        for row in self.db.execute('SELECT item FROM messages WHERE deleted=0 ORDER BY mid'):
            item=json.loads(row['item'])
            if item['mid'] in assigned or (namespace and item['namespace']!=namespace) or (conversation and item['conversation']!=conversation):continue
            items.append({'mid':item['mid'],'namespace':item['namespace'],'conversation':item['conversation'],'record_id':item['record_id'],
                          'role':item['raw']['role'],'created_at':item['raw'].get('created_at'),'content_chars':len(item['raw']['content']),
                          'source_ref':{k:v for k,v in item.items() if k not in ('raw','locators')},'locators':item['locators']})
        return {'messages':items[offset:offset+limit],'total':len(items),'next_offset':offset+limit if offset+limit<len(items) else None,
                'notice':'Unorganized source messages; these are not event boundaries or accepted memories'}

    def catalog(self,offset=0,limit=30,tags=None,status=None):
        if offset<0 or not 1<=limit<=100:raise ValueError('Invalid catalog page')
        events,_,threads=self.project()
        items=[{'event_id':e['event_id'],'alias':e.get('alias'),'name':e['name'],'one_line':e.get('one_line'),
                 'time':e.get('time'),'tags':self.tags(e),'status':e['status'],'needs_review':e['needs_review'],'revision':e['revision']} for e in events.values()
               if (not status or e['status']==status) and (not tags or set(tags).issubset(self.tags(e)))]
        items.sort(key=lambda e:(str(e.get('time',{}).get('start','')),e['event_id']))
        return {'events':items[offset:offset+limit],'total':len(items),'next_offset':offset+limit if offset+limit<len(items) else None,'threads':list(threads.values()),'raw_content_included':False}

    def export_catalog(self):
        events=[];offset=0
        while True:
            result=self.catalog(offset,100);events+=result['events']
            if result['next_offset'] is None:break
            offset=result['next_offset']
        lines=['# 人格的记忆目录','',f'生成观察时间：{now()}。标题和一句话来自人格；仅覆盖已整理子集。','',
               '这是按需阅读入口，不自动进入核心或日常上下文。原文通过 memory_open 明确打开。','']
        for e in events:lines.extend([f"- {e['time'].get('start','未知时间')} · **{e['alias']}: {e['name']}** · {e['status']}"+( ' · 来源变化待复核' if e['needs_review'] else ''),f"  {e.get('one_line','')}  (`{e['event_id']}`)"])
        self.export.mkdir(parents=True,exist_ok=True)
        atomic_json(self.export/'catalog.json',{'generated_at':now(),'events':events,'threads':self.catalog()['threads']})
        path=self.export/'catalog.md';temp=path.with_suffix('.tmp');temp.write_text('\n'.join(lines)+'\n',encoding='utf-8');temp.replace(path)
        atomic_json(self.export/'journal-export.json',{'generated_at':now(),'authority':'protected append-only journal; this is a rebuildable readable export','entries':self.ledger()})
        return {'catalog':str(path),'events':len(events),'github_published':False,'dots_read_verified':False}

    def status(self):
        events,_,threads=self.project()
        audit_path=self.store/'api-requests.jsonl'
        requests=[json.loads(line) for line in audit_path.read_text('utf-8').splitlines()] if audit_path.exists() else []
        assigned={r['mid'] for e in events.values() for r in e.get('source_refs',[])+e.get('side_refs',[])}
        return {'events':len(events),'accepted':sum(e['status']=='accepted' for e in events.values()),'needs_review':sum(e['needs_review'] for e in events.values()),
                'entrances':sum(len(e['units']) for e in events.values()),'threads':len(threads),'messages':self.db.execute('SELECT count(*) FROM messages WHERE deleted=0').fetchone()[0],
                'unorganized_messages':self.db.execute('SELECT count(*) FROM messages WHERE deleted=0').fetchone()[0]-len(assigned),
                'vector_cache_entries':self.db.execute('SELECT count(*) FROM vectors').fetchone()[0],
                'api_requests':len(requests),'embedding_requests':sum(r['operation']=='embedding' for r in requests),'rerank_requests':sum(r['operation']=='rerank' for r in requests),
                'reported_usage':[r.get('usage') for r in requests],'account_debit_verified':False,'deepseek_budget_covers_qwen':False,
                'automatic_context_injection':False,'automatic_background_jobs':False}

    def rebuild(self):
        self.ledger()  # Authored decisions must validate before cache recovery.
        self.close()
        backup=self.db_path.with_name('index.before-rebuild.'+uuid.uuid4().hex+'.sqlite3')
        if self.db_path.exists():self.db_path.replace(backup)
        try:
            if self.observations.exists():
                for line in self.observations.read_text('utf-8').splitlines():
                    obs=json.loads(line);item=obs['item']
                    if digest(compact(item['raw']))!=item['revision_hash'] or digest(item['raw']['content'])!=item['content_hash']:raise RuntimeError('Source observation integrity failed; retain evidence and inspect')
                    self.db.execute('INSERT OR IGNORE INTO versions VALUES(?,?,?,?)',(item['mid'],item['revision_hash'],compact(item),obs['observed_at']))
                    self.db.execute('INSERT OR REPLACE INTO messages VALUES(?,?,?)',(item['mid'],compact(item),int(obs['deleted'])))
            self.db.commit();result=self.sync();self.project()
        except BaseException:
            self.close()
            if self.db_path.exists():self.db_path.replace(self.db_path.with_name('index.failed-rebuild.'+uuid.uuid4().hex+'.sqlite3'))
            if backup.exists():backup.replace(self.db_path)
            raise
        return {'rebuilt':True,'backup':str(backup) if backup.exists() else None,'sync':result,'vectors_rebuilt':False,'next':'embed explicitly calls Qwen; IDs/annotations survive without API'}
