import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExperimentServer } from '../../src/http/app.mjs';

const allowedOrigin = 'http://172.27.46.183:4173';

test('HTTP server applies CORS to health, readiness, preflight and rejected origins', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr-cors-test-'));
  const packageRoot = path.join(root, 'media');
  await mkdir(packageRoot);

  const service = await createExperimentServer({
    packageRoot,
    resultsRoot: path.join(root, 'runs'),
    scenarios: new Map(),
    experiment: {
      id: 'abr-under-uncertainty-v1',
      sha256: '1'.repeat(64),
      packageSha256: '2'.repeat(64),
    },
    allowedOrigins: new Set([allowedOrigin]),
  });

  t.after(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });

  const address = await service.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/healthz`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(health.status, 200);
  assert.equal(health.headers.get('access-control-allow-origin'), allowedOrigin);

  const readiness = await fetch(`${base}/readyz`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(readiness.status, 503);
  assert.equal(readiness.headers.get('access-control-allow-origin'), allowedOrigin);

  const preflight = await fetch(`${base}/api/v1/runs`, {
    method: 'OPTIONS',
    headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowedOrigin);

  const rejected = await fetch(`${base}/healthz`, {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('access-control-allow-origin'), null);
});
