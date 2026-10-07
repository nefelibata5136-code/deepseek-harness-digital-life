import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {signApproval,readApproved,approvalFile} from './bundle/approvals.mjs';
test('DM approval requires signed human evidence for exact owner, action and conversation',()=>{
 const root=mkdtempSync(join(tmpdir(),'moltbook-approval-')),key='TEST_ONLY_SECRET_NOT_REAL';
 const grant={lifeId:'life-A',actionId:'approve-1',conversationId:'conv-1',humanPrincipal:'human:maintainer',expiresAt:new Date(Date.now()+60000).toISOString()};
 writeFileSync(approvalFile(root,'conv-1'),JSON.stringify({grant,signature:signApproval(grant,key)}));
 assert(readApproved(grant,root,key));assert(!readApproved({...grant,lifeId:'life-B'},root,key));
 assert(!readApproved({...grant,actionId:'approve-2'},root,key));assert(!readApproved(grant,root,'wrong'));
 writeFileSync(approvalFile(root,'conv-1'),JSON.stringify({grant:{...grant,expiresAt:'3000-01-01T00:00:00.000Z'},signature:signApproval(grant,key)}));
 assert(!readApproved(grant,root,key));
});
