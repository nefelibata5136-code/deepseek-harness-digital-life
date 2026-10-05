// Reuse A's pinned installation. No npm installation or vendor edits.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
export const nativeRequire = createRequire(new URL('../native_dsh/package.json', import.meta.url));
export const native = name => import(pathToFileURL(nativeRequire.resolve('@deepseek-ai/' + name)).href);
export const here = fileURLToPath(new URL('.', import.meta.url));
