// Owner-scoped composition of the existing Digital Life preset capabilities.
// Retain durable preset/header IDs; reuse resident.mjs and state-board.mjs.
export function ownerDigitalLifePreset(manifest,declaration) {
  if(declaration.id!==manifest.deployment.presetId)throw new Error('DIGITAL_LIFE_PRESET_OWNER_MISMATCH');
  return {...declaration,plugins:[...declaration.plugins,{
    id:'digital-life-foundation',name:new URL('./owner-preset.mjs',import.meta.url).href,
    isolate:{personaLife:true,personaHost:true,personaTasks:true,digitalLifeFoundation:true},
    config:{lifeId:manifest.lifeId,presetId:manifest.deployment.presetId}
  },{id:'digital-life-social',name:new URL('./social-preset.mjs',import.meta.url).href,isolate:{digitalLifeSocial:true}}]};
}
