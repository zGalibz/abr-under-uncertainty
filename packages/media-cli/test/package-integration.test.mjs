import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { packageMedia, validateMediaPackage } from '../src/package-hls.mjs';

const exec = promisify(execFile);

test('packages and validates a short four-rendition aligned HLS fixture', { timeout: 180000 }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'abr-media-test-'));
  try {
    const source = path.join(temp, 'source.mp4');
    const output = path.join(temp, 'media');
    await exec('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=4',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
    ]);
    const packaged = await packageMedia({ source, output, preset: 'ultrafast', licenseClaim: 'generated test fixture' });
    assert.equal(packaged.manifest.renditions.length, 4);
    assert.equal(packaged.manifest.renditions.every((item) => item.segmentCount === 2), true);
    assert.equal(packaged.report.valid, true);
    const rerun = await validateMediaPackage({ output });
    assert.equal(rerun.valid, true);
    const manifestPath = path.join(output, 'package.json');
    const originalManifest = await readFile(manifestPath, 'utf8');
    const falsified = JSON.parse(originalManifest);
    falsified.renditions[0].measuredPeakBps += 1;
    falsified.renditions[0].segments[0].firstVideoPts90k += 3000;
    await writeFile(manifestPath, `${JSON.stringify(falsified, null, 2)}\n`);
    const withFalseMetadata = await validateMediaPackage({ output });
    assert.equal(withFalseMetadata.valid, false);
    assert.match(withFalseMetadata.errors.join('\n'), /metadata mismatch/);
    await writeFile(manifestPath, originalManifest);
    await writeFile(path.join(output, 'v0', 'unexpected.ts'), 'not part of the package');
    const withExtra = await validateMediaPackage({ output });
    assert.equal(withExtra.valid, false);
    assert.match(withExtra.errors.join('\n'), /unexpected package file: v0\/unexpected\.ts/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
