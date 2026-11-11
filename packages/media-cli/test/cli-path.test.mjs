import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveUserPath } from '../src/cli-path.mjs';

test('resolves npm workspace CLI paths from INIT_CWD', () => {
  assert.equal(resolveUserPath('assets/source/source.mp4', { cwd: '/repo/packages/media-cli', initCwd: '/repo' }), '/repo/assets/source/source.mp4');
});

test('preserves absolute CLI paths', () => {
  assert.equal(resolveUserPath('/tmp/source.mp4', { cwd: '/repo/packages/media-cli', initCwd: '/repo' }), '/tmp/source.mp4');
});
