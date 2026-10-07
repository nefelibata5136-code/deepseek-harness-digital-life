import {readFile,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inspectLegacy} from './legacy.mjs';
import {validateManifest,canonical,contains,fail,attachmentLayout} from './contracts.mjs';

// Read-only plan, no Registry constructor, Agent, credential resolution or boot.
export async function checkPreparation({migrationRoot=fileURLToPath(new URL('../../..',import.meta.url))}={}) {
  const legacy=validateManifest(await inspectLegacy({migrationRoot}),'production');
  const pkg=JSON.parse(await readFile(resolve(migrationRoot,'runtime/native_dsh/node_modules/@deepseek-ai/dsh/package.json'),'utf8'));
  return {observedAt:new Date().toISOString(),readOnly:true,nativeVersion:pkg.version,
    architecture:'one-native-host-with-owner-scopes',privacy:'logical-owner-routing',osStrongIsolation:false,
    legacyMetadataBinding:legacy,nativeAttachmentLayout:attachmentLayout(legacy),
    pathsPresent:Object.fromEntries(Object.entries(legacy.deployment).filter(([,v])=>typeof v==='string'&&/^[A-Z]:[/\\]/i.test(v)).map(([k,v])=>[k,existsSync(v)])),
    nativeSessionHeaderVerified:false,liveHostInspected:false,credentialStoreAccessed:false,productionActivated:false,formalLifeRegistrations:0,
    remainingActivationInputs:['explicit formal Registry metadata import','verified original Session headers/projection and owner lineage',
      'explicit legacy permission policies','explicit per-life Memory/account/browser/credential bindings',
      'reviewed provider account budget policy','control-side deployment and real native acceptance'],
    secondLifeInitializationRequested:false,fixturePromotionAllowed:false};
}
if(process.argv[1]&&canonical(resolve(process.argv[1]))===canonical(fileURLToPath(import.meta.url))) {
  const args=process.argv.slice(2);if(args[0]!=='--check'||args.length!==1&&!(args.length===3&&args[1]==='--output'))fail('READ_ONLY_CHECK_USAGE');
  const result=await checkPreparation();
  if(args[1]) {
    const target=canonical(resolve(args[2])),reportRoot=canonical(fileURLToPath(new URL('../../../reports/multi-life-implementation-20261006',import.meta.url)));
    if(!contains(reportRoot,target))fail('PREPARATION_REPORT_OUTSIDE_TASK_REPORTS');
    await writeFile(target,JSON.stringify(result,null,2)+'\n');
  }
  console.log(JSON.stringify(result));
}
