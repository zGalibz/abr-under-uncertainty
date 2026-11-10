import test from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryClient, forwardBufferSeconds } from '../src/telemetry.js';
import { MockRunApi } from '../src/mocks/mock-run-api.js';

const runId = 'r_017f22e2-79b0-7cc3-98c4-dc0c0c07398f';

test('telemetry has contiguous sequences and retries the identical batch after failure', async () => {
  const batches = []; let failOnce = true;
  const client = new TelemetryClient({ runId, batchSize: 2, flushIntervalMs: 60_000, monoNow: (() => { let t = 0; return () => ++t; })(),
    transport: { appendEvents: async (_id, body) => { batches.push(body.events.map((event) => event.seq)); if (failOnce) { failOnce = false; throw new Error('temporary'); } return { accepted: body.events.length }; } } });
  client.emit('media.play_requested', { muted: false, autoplay: false }); client.emit('media.playing', { readyState: 4, forwardBufferSec: 3 }, 0);
  await assert.rejects(client.flush()); await client.flushAll(); await client.close();
  assert.deepEqual(batches, [[0, 1], [0, 1]]);
});

test('forward-buffer calculation uses only the range containing the playhead', () => {
  const video = { currentTime: 5, buffered: { length: 2, start: (i) => [0, 10][i], end: (i) => [4, 20][i] } };
  assert.equal(forwardBufferSeconds(video), 0);
  video.currentTime = 2; assert.equal(forwardBufferSeconds(video), 2);
});

test('MOCK lifecycle stores idempotent event batches without pretending to be a measurement', async () => {
  const api = new MockRunApi(); const run = await api.createRun({ requestId: '00000000-0000-4000-8000-000000000000', experimentId: 'abr-under-uncertainty-v1', scenarioId: 'stable-v1', repetition: 1 });
  await api.startRun(run.runId); const event = { schemaVersion: '1.0.0', runId: run.runId, source: 'player', seq: 0, type: 'media.play_requested', clientMonoMs: 1, clientEpochMs: 1, data: { muted: false, autoplay: false } };
  assert.equal((await api.appendEvents(run.runId, { events: [event] })).accepted, 1);
  assert.equal((await api.appendEvents(run.runId, { events: [event] })).duplicates, 1);
  assert.equal(api.eventsFor(run.runId).length, 1);
});
