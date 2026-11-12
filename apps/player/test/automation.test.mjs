import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAX_WALL_MS, readAutomationParams } from '../src/automation.js';

const RUN_ID = 'r_019a7b3c-1d2e-7f40-8a51-b2c3d4e5f607';

test('a page URL without runId is a normal manual page load', () => {
  assert.equal(readAutomationParams(''), null);
  assert.equal(readAutomationParams('?policyId=default-hlsjs'), null);
});

test('the runner URL is parsed into the run to start', () => {
  const params = readAutomationParams(`?api=${encodeURIComponent('http://127.0.0.1:8080/')}&runId=${RUN_ID}&policyId=conservative-throughput-v1&maxWallMs=240000`);
  assert.deepEqual(params, { runId: RUN_ID, policyId: 'conservative-throughput-v1', apiBase: 'http://127.0.0.1:8080', maxWallMs: 240000 });
  assert.equal(readAutomationParams(`?api=http://127.0.0.1:8080&runId=${RUN_ID}&policyId=default-hlsjs`).maxWallMs, DEFAULT_MAX_WALL_MS);
});

test('a malformed runner URL is refused instead of falling back to a manual run', () => {
  const base = `api=http://127.0.0.1:8080&runId=${RUN_ID}&policyId=default-hlsjs`;
  assert.throws(() => readAutomationParams(`?${base.replace(RUN_ID, 'r_not-a-uuid')}`), /invalid runId/);
  assert.throws(() => readAutomationParams(`?${base.replace('default-hlsjs', 'aggressive')}`), /unknown policyId/);
  assert.throws(() => readAutomationParams(`?runId=${RUN_ID}&policyId=default-hlsjs`), /api must be an absolute/);
  assert.throws(() => readAutomationParams(`?${base.replace('http://127.0.0.1:8080', 'file:///tmp')}`), /api must be http/);
  assert.throws(() => readAutomationParams(`?${base}&maxWallMs=0`), /maxWallMs/);
  assert.throws(() => readAutomationParams(`?${base}&maxWallMs=1.5`), /maxWallMs/);
});
