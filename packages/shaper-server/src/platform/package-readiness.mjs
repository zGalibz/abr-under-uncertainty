import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function verifyPackagePayload({ packageRoot, expectedManifestSha256 }) {
  try {
    const manifestBytes = await readFile(path.join(packageRoot, 'package.json'));
    if (sha256(manifestBytes) !== expectedManifestSha256) throw new Error('package manifest digest mismatch');
    const manifest = JSON.parse(manifestBytes);
    const entries = Object.entries(manifest.files ?? {});
    if (entries.length === 0) throw new Error('package manifest has no payload files');
    for (const [relative, expected] of entries) {
      if (path.isAbsolute(relative) || relative.split('/').includes('..') || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`unsafe package manifest entry: ${relative}`);
      const absolute = path.resolve(packageRoot, relative);
      const prefix = `${path.resolve(packageRoot)}${path.sep}`;
      if (!absolute.startsWith(prefix)) throw new Error(`package entry escapes root: ${relative}`);
      const actual = sha256(await readFile(absolute));
      if (actual !== expected) throw new Error(`package payload digest mismatch: ${relative}`);
    }
    return { ready: true, error: null };
  } catch (error) {
    return { ready: false, error: error.message };
  }
}
