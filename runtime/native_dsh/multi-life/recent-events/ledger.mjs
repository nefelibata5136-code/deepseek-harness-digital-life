import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync,readdirSync,existsSync,openSync,closeSync,writeSync,fsyncSync,statSync,readSync,ftruncateSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {recentPolicy} from './policy.mjs';

// JSONL is the immutable source. SQLite is an indexed projection, not an
// independent writer. Only the unindexed tail of the current/next segment is
// read on ordinary reopen. Missing/corrupt index explicitly invokes rebuild.
export class SegmentedLedger {
  constructor({root,validate,serialize,segmentEvents=recentPolicy.segmentEvents,fault=()=>{}}) {
    Object.assign(this,{root,validate,serialize,segmentEvents,fault});
    this.dir=join(root,'ledger');mkdirSync(this.dir,{recursive:true});this.path=join(root,'event-index.sqlite');
    this.metrics={files:0,bytes:0,rows:0,fullScans:0};
    let rebuild=!existsSync(this.path);
    try {this.db=new DatabaseSync(this.path);if(!rebuild){const row=this.db.prepare('SELECT value FROM meta WHERE key=?').get('head');if(!row)throw Error('MISSING_INDEX_HEAD');const head=JSON.parse(row.value);if(!Number.isSafeInteger(head.lastSequence)||head.lastSequence<0||!Number.isSafeInteger(head.segment)||head.segment<1||!Number.isSafeInteger(head.offset)||head.offset<0||this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM events').get().seq!==head.lastSequence)throw Error('CORRUPT_INDEX_HEAD');}}
    catch(error) {
      this.db?.close();
      if(existsSync(this.path))renameSync(this.path,this.path+'.corrupt-'+Date.now());
      this.db=new DatabaseSync(this.path);rebuild=true;
    }
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,source TEXT UNIQUE,record TEXT NOT NULL,segment INTEGER NOT NULL,offset INTEGER NOT NULL,length INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audience(life TEXT NOT NULL,seq INTEGER NOT NULL,scope TEXT NOT NULL,PRIMARY KEY(life,scope,seq));
      CREATE INDEX IF NOT EXISTS audience_life_seq ON audience(life,seq);
      CREATE TRIGGER IF NOT EXISTS immutable_events_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_events_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVENT'); END;`);
    if(rebuild)this.rebuild();else {this.head=JSON.parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get('head').value);this.recoverTail();if(!this.db.prepare("SELECT value FROM meta WHERE key='migration'").get())this.resumeMigration();}
  }
  file(segment){return join(this.dir,'segment-'+String(segment).padStart(6,'0')+'.jsonl');}
  read(path,offset=0) {
    this.metrics.files++;const size=statSync(path).size;if(size<offset)throw Error('RECENT_LEDGER_TRUNCATED');
    const bytes=Buffer.alloc(size-offset),fd=openSync(path,'r');
    try {let n=0;while(n<bytes.length){const got=readSync(fd,bytes,n,bytes.length-n,offset+n);if(!got)throw Error('RECENT_LEDGER_SHORT_READ');n+=got;}}finally{closeSync(fd);}
    this.metrics.bytes+=bytes.length;return bytes;
  }
  index(event,segment,offset,length) {
    this.metrics.rows++;
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(event.seq,event.event_id,event.source_key,this.serialize(event),segment,offset,length);
    for(const life of event.visibility.members)this.db.prepare('INSERT INTO audience VALUES(?,?,?)').run(life,event.seq,event.payload?.scope_session_id??'');
    this.head={segment,count:segment===this.head.segment?this.head.count+1:1,lastSequence:event.seq,offset:offset+length};
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('head',JSON.stringify(this.head));
  }
  importTail(segment,{repairPartial=true}={}) {
    const path=this.file(segment);if(!existsSync(path))return;
    const start=segment===this.head.segment?this.head.offset:0,bytes=this.read(path,start);
    let cursor=0;const before={...this.head};this.db.exec('BEGIN IMMEDIATE');try {
    while(cursor<bytes.length) {
      const end=bytes.indexOf(10,cursor);
      if(end<0) {
        if(!repairPartial)throw Error('RECENT_LEDGER_INCOMPLETE_SEALED_SEGMENT');
        // Preserve the interrupted bytes before removing only the uncommitted
        // suffix. No complete event and no indexed byte is ever removed.
        const suffix=bytes.subarray(cursor),evidence=path+'.partial-'+Date.now();
        const evidenceFd=openSync(evidence,'wx');try{writeSync(evidenceFd,suffix);fsyncSync(evidenceFd);}finally{closeSync(evidenceFd);}
        const fd=openSync(path,'r+');try{ftruncateSync(fd,start+cursor);fsyncSync(fd);}finally{closeSync(fd);}break;
      }
      const event=this.validate(JSON.parse(bytes.subarray(cursor,end).toString('utf8')));
      if(event.seq!==this.head.lastSequence+1)throw Error('RECENT_LEDGER_SEQUENCE_INVALID');
      this.index(event,segment,start+cursor,end-cursor+1);
      cursor=end+1;
    }
    this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');this.head=before;throw error;}
  }
  recoverTail() {
    if(!Number.isSafeInteger(this.head.lastSequence)||this.head.lastSequence<0||this.head.offset<0)throw Error('RECENT_LEDGER_INDEX_INVALID');
    this.importTail(this.head.segment);
    if(this.head.count>=this.segmentEvents)this.importTail(this.head.segment+1);
  }
  rebuild() {
    this.metrics.fullScans++;this.head={segment:1,count:0,lastSequence:0,offset:0};
    const segments=readdirSync(this.dir).filter(x=>/^segment-\d{6}\.jsonl$/.test(x)).sort();
    if(segments.length) {
      for(let i=0;i<segments.length;i++){const n=Number(segments[i].slice(8,14));if(n!==i+1)throw Error('RECENT_LEDGER_SEGMENT_GAP');this.importTail(n,{repairPartial:i===segments.length-1});}
    }else {
      // One-time legacy migration. Originals remain untouched. An interrupted
      // migration is resumed by exact seq/hash, even when segments now exist.
      const old=join(this.root,'events');
      for(const name of (existsSync(old)?readdirSync(old):[]).filter(x=>/^\d{16}-[a-f0-9]{64}\.json$/.test(x)).sort()) {
        this.metrics.files++;const bytes=readFileSync(join(old,name));this.metrics.bytes+=bytes.length;
        this.append(this.validate(JSON.parse(bytes.toString('utf8'))));
      }
    }
    this.resumeMigration();
  }
  resumeMigration() {
    // Maintenance path only: legacy suffix after an interrupted migration.
    const old=join(this.root,'events');
    if(existsSync(old))for(const name of readdirSync(old).filter(x=>/^\d{16}-[a-f0-9]{64}\.json$/.test(x)).sort()) {
      this.metrics.files++;const bytes=readFileSync(join(old,name));this.metrics.bytes+=bytes.length;
      const event=this.validate(JSON.parse(bytes.toString('utf8'))),existing=this.get(event.event_id);
      if(existing){if(existing.record_hash!==event.record_hash)throw Error('RECENT_MIGRATION_EVIDENCE_CONFLICT');}
      else this.append(event);
    }
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('head',JSON.stringify(this.head));
    this.db.prepare('INSERT OR REPLACE INTO meta VALUES(?,?)').run('migration',JSON.stringify({legacyArchive:'events',lastSequence:this.head.lastSequence}));
  }
  append(event) {
    if(event.seq!==this.head.lastSequence+1)throw Error('RECENT_LEDGER_SEQUENCE_INVALID');
    const segment=this.head.count>=this.segmentEvents?this.head.segment+1:this.head.segment,offset=segment===this.head.segment?this.head.offset:0;
    const path=this.file(segment),bytes=Buffer.from(this.serialize(event)+'\n');
    this.metrics.files++;
    // Constant-size head comparison. No directory scan/stat of sealed files.
    if(existsSync(path)&&statSync(path).size!==offset)throw Error('RECENT_LEDGER_STALE_APPEND');
    const fd=openSync(path,'a');try{let n=0;while(n<bytes.length)n+=writeSync(fd,bytes,n,bytes.length-n);fsyncSync(fd);}finally{closeSync(fd);}
    this.fault('after-append');
    this.db.exec('BEGIN IMMEDIATE');try{this.index(event,segment,offset,bytes.length);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    this.metrics.bytes+=bytes.length;this.fault('after-index');return event;
  }
  get(id){const row=this.db.prepare('SELECT record FROM events WHERE id=?').get(id);this.metrics.rows+=row?1:0;return row?JSON.parse(row.record):null;}
  bySource(source){const row=this.db.prepare('SELECT record FROM events WHERE source=?').get(source);this.metrics.rows+=row?1:0;return row?JSON.parse(row.record):null;}
  page(life,{after=0,before=Number.MAX_SAFE_INTEGER,limit=100,descending=false,sessionId}={}) {
    const scope=sessionId===undefined?'':' AND (a.scope=\'\' OR a.scope=?)';
    const params=sessionId===undefined?[life,after,before,limit]:[life,after,before,sessionId,limit];
    const rows=this.db.prepare(`SELECT e.record FROM audience a JOIN events e ON e.seq=a.seq WHERE a.life=? AND a.seq>? AND a.seq<=?${scope} ORDER BY a.seq ${descending?'DESC':'ASC'} LIMIT ?`).all(...params);
    this.metrics.rows+=rows.length;return rows.map(row=>JSON.parse(row.record));
  }
  all(){const rows=this.db.prepare('SELECT record FROM events ORDER BY seq').all();this.metrics.rows+=rows.length;return rows.map(row=>JSON.parse(row.record));}
  audit() {
    this.metrics.fullScans++;let sequence=0,segments=0;
    for(const name of readdirSync(this.dir).filter(x=>/^segment-\d{6}\.jsonl$/.test(x)).sort()) {
      segments++;const bytes=this.read(join(this.dir,name));let offset=0;
      while(offset<bytes.length){const end=bytes.indexOf(10,offset);if(end<0)throw Error('RECENT_AUDIT_INCOMPLETE_LINE');const event=this.validate(JSON.parse(bytes.subarray(offset,end).toString('utf8')));
        if(event.seq!==++sequence||this.get(event.event_id)?.record_hash!==event.record_hash)throw Error('RECENT_AUDIT_INDEX_MISMATCH');offset=end+1;}
    }
    if(sequence!==this.head.lastSequence)throw Error('RECENT_AUDIT_HEAD_MISMATCH');
    return {verified:true,events:sequence,segments,lastSequence:sequence};
  }
  resetMetrics(){this.metrics={files:0,bytes:0,rows:0,fullScans:0};}
  close(){this.db.close();}
}
