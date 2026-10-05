import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const installAnchor = fileURLToPath(new URL('../native_dsh/node_modules/@deepseek-ai/dsh/package.json', import.meta.url));
const requireNative = createRequire(installAnchor);
export const loadPackage = name => import(pathToFileURL(requireNative.resolve(name)).href);
