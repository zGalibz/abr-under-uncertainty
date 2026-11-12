import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpRunApi, resolveRunHlsUrl } from '../src/run-api.js';

test('HTTP API uses the configured experiment-server origin and lifecycle routes', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
  const api = new HttpRunApi({ baseUrl: 'http://192.0.2.10:8080/' });
  await api.createRun({ requestId: 'x' });
  await api.abortRun('r_test', { reason: 'user abort' });
  assert.equal(calls[0].url, 'http://192.0.2.10:8080/api/v1/runs');
  assert.equal(calls[1].url, 'http://192.0.2.10:8080/api/v1/runs/r_test/abort');
});

test('server-issued run-scoped HLS path is resolved against the experiment server', () => {
  assert.equal(resolveRunHlsUrl('/stream/v1/r_abc/master.m3u8', 'http://192.0.2.10:8080'), 'http://192.0.2.10:8080/stream/v1/r_abc/master.m3u8');
  assert.throws(() => resolveRunHlsUrl('/media/master.m3u8', 'http://192.0.2.10:8080'), /run-scoped/);
});
