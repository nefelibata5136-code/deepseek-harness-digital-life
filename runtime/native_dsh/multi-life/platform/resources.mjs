import {createFileLocks} from '../../../workspace_foundation/file-operation-locks.mjs';
import {canonical} from '../contracts.mjs';

// Runtime resource coordination; unrelated to disabled development Presence locks.
export class ResourceBroker {
  constructor({contexts,locks=createFileLocks()}){Object.assign(this,{contexts,locks});}
  fileKey(path){return canonical(path).replaceAll('\\','/');}
  async withFile(context,path,signal,operation) {
    this.contexts.require(context);const lease=await this.locks.acquire(this.fileKey(path),context.sessionId,signal);
    try {signal.throwIfAborted();this.contexts.require(context);return await operation();}
    finally {lease.release();}
  }
  async withDesktop(context,signal,operation) {
    this.contexts.require(context);const lease=await this.locks.acquire('desktop:windows-login-input',context.sessionId,signal);
    try {signal.throwIfAborted();this.contexts.require(context);return await operation();}
    finally {lease.release();}
  }
  async withBrowser(context,binding,signal,operation) {
    this.contexts.require(context);
    if(binding.lifeId!==context.lifeId||!binding.bindingRef||!binding.profileRoot)throw Error('BROWSER_OWNER_BINDING_REQUIRED');
    const lease=await this.locks.acquire('browser:'+this.fileKey(binding.profileRoot),context.sessionId,signal);
    try {signal.throwIfAborted();this.contexts.require(context);return await operation(binding);}
    finally {lease.release();}
  }
}
