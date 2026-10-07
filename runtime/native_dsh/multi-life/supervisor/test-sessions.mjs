import {existsSync,readFileSync,writeFileSync,renameSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail} from '../contracts.mjs';

// Host-created activity metadata only. Restart never invents a life or copies a
// main conversation; each entry resumes its exact original native Session.
export class TestSessionStore {
  constructor(path,{lifeId,authoritySessionId}) {
    this.path=path;this.lifeId=lifeId;this.authoritySessionId=authoritySessionId;
    const value=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{schema_version:1,life_id:lifeId,sessions:[]};
    if(value.schema_version!==1||value.life_id!==lifeId||!Array.isArray(value.sessions))fail('TEST_SESSION_STORE_INVALID');
    this.rows=new Map();for(const row of value.sessions){this.validate(row);if(this.rows.has(row.session_id))fail('TEST_SESSION_STORE_INVALID');this.rows.set(row.session_id,row);}
  }
  validate(row) {
    if(!/^[a-f0-9-]{36}$/i.test(row?.session_id??'')||row.session_id===this.authoritySessionId||typeof row.title!=='string'||!row.title.trim()||row.title.length>120)fail('EXPLICIT_TEST_SESSION_REQUIRED');
  }
  list(){return [...this.rows.values()];}
  add(row) {
    this.validate(row);const existing=this.rows.get(row.session_id);if(existing)return existing;
    const value={session_id:row.session_id,title:row.title.trim(),source:'host-developer-ultra-test',created_at:new Date().toISOString()};
    this.rows.set(value.session_id,value);mkdirSync(dirname(this.path),{recursive:true});
    const tmp=this.path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify({schema_version:1,life_id:this.lifeId,sessions:this.list()},null,2)+'\n',{flag:'wx'});renameSync(tmp,this.path);return value;
  }
}
