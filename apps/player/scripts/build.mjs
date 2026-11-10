import { cp, mkdir, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(appRoot, 'dist');
const hlsBundle = path.resolve(appRoot, '../../node_modules/hls.js/dist/hls.min.js');
try { await access(hlsBundle, constants.R_OK); } catch { throw new Error('hls.js 1.7.4 is not installed. Run npm ci at repository root.'); }
await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
await cp(path.join(appRoot, 'src'), dist, { recursive: true }); await cp(hlsBundle, path.join(dist, 'hls.min.js'));
console.log(`Built local player bundle at ${dist}`);
