import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalize, sha256Canonical } from '../../src/domain/canonical-json.mjs';
import { createUuidV7Generator, formatRunId, isRunId } from '../../src/domain/uuid-v7.mjs';
import { parseSingleRange } from '../../src/domain/range.mjs';
import { compileSchedule, validateScenarioSemantics } from '../../src/domain/scenario.mjs';
import { createAssetResolver } from '../../src/platform/safe-asset-resolver.mjs';
import { rewritePlaylist } from '../../src/domain/playlist-rewriter.mjs';

test('canonical JSON sorts recursively and hashes stable semantic content', () => {
  assert.equal(canonicalize({ z: 1, a: { y: 2, x: 3 } }), '{"a":{"x":3,"y":2},"z":1}');
  assert.equal(sha256Canonical({ b: 2, a: 1 }), sha256Canonical({ a: 1, b: 2 }));
  assert.throws(() => canonicalize({ bad: Number.NaN }), /finite/);
});

test('UUIDv7 generator emits valid lexically increasing run IDs', () => {
  const generator = createUuidV7Generator({ wallClock: { nowEpochMs: () => 1700000000000 }, randomBytes: () => Buffer.alloc(10, 0) });
  const first = formatRunId(generator.next());
  const second = formatRunId(generator.next());
  assert.equal(isRunId(first), true);
  assert.ok(second > first);
});

test('single range parser handles full bounded open and suffix forms', () => {
  assert.deepEqual(parseSingleRange(undefined, 10), { kind: 'full', start: 0, end: 9, length: 10 });
  assert.deepEqual(parseSingleRange('bytes=0-0', 10), { kind: 'partial', start: 0, end: 0, length: 1 });
  assert.deepEqual(parseSingleRange('bytes=3-', 10), { kind: 'partial', start: 3, end: 9, length: 7 });
  assert.deepEqual(parseSingleRange('bytes=-4', 10), { kind: 'partial', start: 6, end: 9, length: 4 });
  assert.equal(parseSingleRange('bytes=10-', 10).kind, 'unsatisfiable');
  assert.equal(parseSingleRange('bytes=0-1,3-4', 10).kind, 'malformed');
});

test('schedule integrates bandwidth exactly across half-open phases', () => {
  const scenario = { phases: [
    { id: 'a', startMs: 0, endMs: 1000, downlinkKbps: 8 },
    { id: 'b', startMs: 1000, downlinkKbps: 16 },
  ] };
  assert.deepEqual(validateScenarioSemantics(scenario), []);
  const schedule = compileSchedule(scenario);
  assert.equal(schedule.phaseAt(999).id, 'a');
  assert.equal(schedule.phaseAt(1000).id, 'b');
  assert.equal(schedule.integratedBytes(500, 1500), 1500);
});

test('asset resolver rejects traversal and symlink escape', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr-assets-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'abr-outside-'));
  await mkdir(path.join(root, 'v0'));
  await writeFile(path.join(root, 'v0', 'seg.ts'), 'ok');
  await writeFile(path.join(outside, 'secret'), 'no');
  await symlink(path.join(outside, 'secret'), path.join(root, 'v0', 'escape.ts'));
  const resolver = await createAssetResolver({ packageRoot: root });
  assert.equal((await resolver.resolve('v0/seg.ts')).relativePath, 'v0/seg.ts');
  await assert.rejects(() => resolver.resolve('../secret'), /INVALID_ASSET_PATH/);
  await assert.rejects(() => resolver.resolve('%2e%2e%2fsecret'), /INVALID_ASSET_PATH/);
  await assert.rejects(() => resolver.resolve('v0/escape.ts'), /INVALID_ASSET_PATH/);
});

test('playlist rewrite namespaces relative URI references', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv0/index.m3u8\n';
  const output = rewritePlaylist({ text, playlistRelativePath: 'master.m3u8', runId: 'r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f' });
  assert.match(output, /\/stream\/v1\/r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f\/v0\/index\.m3u8/);
  assert.throws(() => rewritePlaylist({ text: '#EXTM3U\n../x.m3u8\n', playlistRelativePath: 'master.m3u8', runId: 'r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f' }), /unsafe playlist URI/);
});
