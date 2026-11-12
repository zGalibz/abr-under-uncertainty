import { cp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(appRoot, 'dist');
const hlsBundle = path.resolve(appRoot, '../../node_modules/hls.js/dist/hls.min.js');
const repositoryRoot = path.resolve(appRoot, '../..');
const execFileAsync = promisify(execFile);

async function git(args) {
  const { stdout } = await execFileAsync('git', args, { cwd: repositoryRoot });
  return stdout.trim();
}

const gitCommit = await git(['rev-parse', 'HEAD']);
if (!/^[0-9a-f]{40}$/.test(gitCommit)) throw new Error('git did not return a 40-character lowercase commit hash');
const gitDirty = (await git(['status', '--porcelain', '--untracked-files=normal'])) !== '';
const serverBaseUrl = process.env.PLAYER_SERVER_URL || '';
try { await access(hlsBundle, constants.R_OK); } catch { throw new Error('hls.js 1.7.4 is not installed. Run npm ci at repository root.'); }
await rm(dist, { recursive: true, force: true }); await mkdir(dist, { recursive: true });
await cp(path.join(appRoot, 'src'), dist, { recursive: true }); await cp(hlsBundle, path.join(dist, 'hls.min.js'));
await writeFile(path.join(dist, 'build-metadata.js'), `// Generated at build time; safe browser-visible build provenance only.\nexport const BUILD_METADATA = ${JSON.stringify({ gitCommit, gitDirty, serverBaseUrl })};\n`);
console.log(`Built local player bundle at ${dist}`);
