import {canonical,contains,privatePaths,fail} from '../contracts.mjs';
// Re-evaluate links at each capability boundary, rather than trusting registration
// time alone. Full Windows-user access is still outside this API boundary.
export function assertOwnerPath(contexts,context,path) {
  const c=contexts.require(context),target=canonical(path);
  for(const manifest of contexts.registry.list())if(manifest.lifeId!==c.lifeId)
    for(const privatePath of privatePaths(manifest))if(contains(canonical(privatePath),target))fail('OTHER_LIFE_PRIVATE_RESOURCE');
  if(contains(canonical(contexts.registry.controlRoot),target))fail('TRUSTED_CONTROL_RESOURCE');
  return target;
}
