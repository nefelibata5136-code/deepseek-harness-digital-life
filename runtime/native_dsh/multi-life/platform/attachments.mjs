import {native} from '../../../workspace_foundation/native.mjs';
import {fail,canonical,attachmentLayout} from '../contracts.mjs';
import {resolve} from 'node:path';

// Independent native stores, common implementation. The returned envelope binds
// the reference to its owner; an attachment id alone never authorizes a read.
export class OwnerAttachments {
  #stores=new Map();
  constructor({ctx,contexts}){Object.assign(this,{ctx,contexts});}
  async storeFor(context) {
    const c=this.contexts.require(context);let item=this.#stores.get(c.lifeId);
    if(!item) {
      const layout=attachmentLayout(c.manifest),root=canonical(layout.root),scope=this.ctx.isolate('attachments');
      item={root,promise:(async()=>{
        await scope.plugin((await native('dsh-attachment-local')).default,{dshHome:layout.home}).await();
        if(canonical(scope.attachments.root)!==canonical(resolve(root,'v1'))||canonical(scope.attachments.cacheRoot)!==canonical(layout.cache))fail('NATIVE_ATTACHMENT_LAYOUT_MISMATCH');
        return scope.attachments;
      })()};this.#stores.set(c.lifeId,item);
    }
    if(item.root!==canonical(c.manifest.deployment.attachments))fail('ATTACHMENT_ROOT_BINDING_CHANGED');
    const store=await item.promise;this.contexts.require(c);return store;
  }
  async saveFile(context,{data,name}) {
    const c=this.contexts.require(context);if(c.role==='delegate')fail('DELEGATE_ATTACHMENT_WRITE_DENIED');
    const attachment=await (await this.storeFor(c)).saveFile({data,name});this.contexts.require(c);return {lifeId:c.lifeId,kind:'file',attachment};
  }
  async readFile(context,ref,signal=new AbortController().signal) {
    const c=this.contexts.require(context);if(ref?.lifeId!==c.lifeId||ref.kind!=='file')fail('ATTACHMENT_OWNER_MISMATCH');
    const chunks=[];for await(const chunk of (await this.storeFor(c)).readFileStream(ref.attachment,signal))chunks.push(chunk);
    this.contexts.require(c);return Buffer.concat(chunks);
  }
}
