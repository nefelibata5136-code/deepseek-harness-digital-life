// Reapprove reviewed bytes and reload only this capability. Never restart the main Host.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli=fileURLToPath(new URL('../native_dsh/capabilities/control.mjs',import.meta.url));
for(const action of ['approve','refresh']) {
  const out=execFileSync(process.execPath,[cli,action,'xiaohongshu'],{encoding:'utf8',windowsHide:true});
  console.log(out.trim());
}
