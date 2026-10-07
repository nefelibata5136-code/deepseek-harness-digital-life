import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,existsSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fail} from '../contracts.mjs';

// One current Room/input document, committed as a SQLite transaction. The old
// rename-based JSON is an immutable import source, never a second live truth.
export function readConversationSnapshot(root){
  const db=new DatabaseSync(resolve(root,'rooms.sqlite'),{readOnly:true});
  try{const row=db.prepare('SELECT revision,data FROM conversation_state WHERE singleton=1').get();
    if(!row)fail('CONVERSATION_SNAPSHOT_UNAVAILABLE');
    return {revision:row.revision,state:JSON.parse(row.data)};
  }finally{db.close();}
}
export class ConversationStorage {
  constructor({root,migrate=state=>({state})}) {
    mkdirSync(root,{recursive:true});this.path=resolve(root,'rooms.sqlite');
    this.db=new DatabaseSync(this.path);
    try {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS conversation_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,data TEXT NOT NULL,source_sha256 TEXT);');
    const existing=this.db.prepare('SELECT * FROM conversation_state WHERE singleton=1').get();
    if(existing){this.revision=existing.revision;this.state=JSON.parse(existing.data);return;}
    const legacyPath=resolve(root,'rooms.json'),bytes=existsSync(legacyPath)?readFileSync(legacyPath):null;
    const source=bytes?JSON.parse(bytes.toString('utf8')):{schemaVersion:3,rooms:{},humans:{},inbox:{},nextInboxSeq:1,nextMessageSeq:1};
    const migrated=migrate(source),state=migrated.state??migrated;
    const digest=bytes?createHash('sha256').update(bytes).digest('hex'):null;
    if(bytes){
      const archive=resolve(root,'rooms-import-'+digest+'.json');
      if(existsSync(archive)){if(!readFileSync(archive).equals(bytes))fail('ROOM_IMPORT_ARCHIVE_CHANGED');}
      else writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
      if(!readFileSync(legacyPath).equals(bytes))fail('ROOM_IMPORT_SOURCE_CHANGED');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO conversation_state VALUES(1,1,?,?)').run(JSON.stringify(state),digest);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    this.revision=1;this.state=state;this.migration=migrated.provenance??null;
    }catch(error){this.close();throw error;}
  }
  commit(state) {
    // Reject a competing writer rather than silently replacing newer data.
    const result=this.db.prepare('UPDATE conversation_state SET revision=revision+1,data=? WHERE singleton=1 AND revision=?').run(JSON.stringify(state),this.revision);
    if(result.changes!==1)fail('CONVERSATION_WRITER_STALE');
    this.revision++;this.state=state;
  }
  close(){if(this.closed)return;this.closed=true;this.db.close();}
}
