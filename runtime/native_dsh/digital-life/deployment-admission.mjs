// Control-side deployment only. Unknown usage retains its full reservation;
// it is not a running HTTP request. Never mutate/account/release ledger rows.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
export function deploymentIdle(status, states) {
  return status.ready === true && status.busy === false && status.activeSessionIds.length === 0
    && Object.entries(states).every(([state, count]) => count === 0 || ['unknown', 'settled', 'accounted_upper'].includes(state));
}
export async function readAttemptStates(database) {
  const code = `import sqlite3,json,sys\nfrom pathlib import Path\ncon=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)\ntry:\n print(json.dumps(dict(con.execute('SELECT state,COUNT(*) FROM attempts GROUP BY state').fetchall())))\nfinally:\n con.close()`;
  const { stdout } = await execute('python', ['-X', 'utf8', '-c', code, database], { windowsHide: true, timeout: 10000 });
  return JSON.parse(stdout);
}
