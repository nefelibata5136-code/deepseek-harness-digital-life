import { existsSync, writeFileSync } from 'node:fs';
const mode = process.argv[2];
process.on('message', event => { if (event.type === 'persona-host-stop') process.exit(0); });
process.on('disconnect', () => process.exit(0));
process.send?.({ type: 'persona-host-ready', sessionId: 'technical', budgetProtected: true });
if (mode === 'normal') setTimeout(() => process.exit(0), 100);
else if (mode === 'crash') setTimeout(() => process.exit(23), 100);
else if (mode === 'crash-once' && !existsSync('crashed-once')) {
  writeFileSync('crashed-once', 'technical'); setTimeout(() => process.exit(23), 100);
}
setInterval(() => {}, 1000);
