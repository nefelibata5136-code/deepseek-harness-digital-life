// Deterministic Host-side binding. Never choose an owner from a tool argument.
export function moltbookCredentialRef(lifeId){
 if(!/^life-[a-f0-9-]{36}$/i.test(lifeId??''))throw Error('MOLTBOOK_TRUSTED_OWNER_REQUIRED');
 return 'DL_LIFE_MOLTBOOK_'+lifeId.slice(5).replaceAll('-','_').toUpperCase();
}
export function moltbookOwnerBinding(context,logicalRef){
 const expected=moltbookCredentialRef(context.lifeId);
 if(logicalRef!==expected)throw Error('MOLTBOOK_CREDENTIAL_OWNER_MISMATCH');
 return Object.freeze({lifeId:context.lifeId,capabilityId:'moltbook',logicalRef:expected,hostRef:expected,
  accountRef:'moltbook:'+context.lifeId,accountKind:'identity'});
}
