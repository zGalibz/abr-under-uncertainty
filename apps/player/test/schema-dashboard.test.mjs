import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import { LiveDashboard } from '../src/dashboard.js';
import { TelemetryClient } from '../src/telemetry.js';

const schema = JSON.parse(fs.readFileSync(new URL('../../../contracts/schemas/telemetry-event.schema.json', import.meta.url)));
const validate = new Ajv2020({ strict: false }).compile(schema);
const runId = 'r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f';

test('emitted telemetry validates against the shared JSON Schema and preserves monotonic sequence/time', async () => {
  let clock = 10; const events = [];
  const client = new TelemetryClient({ runId, flushIntervalMs: 60_000, monoNow: () => (clock -= 1), epochNow: () => 123, onEvent: (event) => events.push(event), transport: { appendEvents: async () => ({ accepted: 1 }) } });
  client.emit('client.ready', { userAgent: 'test', hlsJsVersion: '1.7.4', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
  client.emit('media.sample', { currentTimeSec: 0, readyState: 4, forwardBufferSec: 2, paused: false, seeking: false, playbackRate: 1 }, 0);
  client.emit('abr.decision', { policyId: 'conservative-throughput-v1', fromLevel: null, toLevel: 0, reason: 'startup_lowest', validSamples: 0, fastBps: null, slowBps: null, estimateBps: null, safetyFactor: null, safeBudgetBps: null, forwardBufferSec: 0, upEvidence: 0 });
  await client.close();
  assert.deepEqual(events.map((event) => event.seq), [0, 1, 2]); assert.ok(events[1].clientMonoMs >= events[0].clientMonoMs);
  for (const event of events) assert.equal(validate(event), true, JSON.stringify(validate.errors));
});

test('telemetry never sends more than the contract maximum of 200 events per batch', async () => {
  const sizes = []; const client = new TelemetryClient({ runId, batchSize: 999, flushIntervalMs: 60_000, transport: { appendEvents: async (_run, body) => { sizes.push(body.events.length); return { accepted: body.events.length }; } } });
  for (let index = 0; index < 205; index += 1) client.emit('media.play_requested', { muted: false, autoplay: false });
  await client.close(); assert.deepEqual(sizes, [200, 5]);
});

test('dashboard renders state supplied by the controller without calculating alternative measurements', () => {
  const nodes = new Map(); const root = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, { textContent: '' }); return nodes.get(selector); } };
  const dashboard = new LiveDashboard(root); dashboard.render({ runState: 'PLAYING', requestedLevel: 0, effectiveLevel: 0, levels: [{ level: 0, width: 640, height: 360, bitrateBps: 596000 }], forwardBufferSec: 5, hlsEstimateBps: 1_000_000, policy: null, stalls: { rebufferCount: 1, rebufferDurationMs: 500 }, resolvedConfig: { hlsJsVersion: '1.7.4', startLevel: -1, capLevelToPlayerSize: false } });
  assert.equal(nodes.get('[data-value="state"]').textContent, 'PLAYING'); assert.match(nodes.get('[data-value="effective"]').textContent, /640×360/); assert.equal(nodes.get('[data-value="stalls"]').textContent, '1 retained / 500 ms');
});
