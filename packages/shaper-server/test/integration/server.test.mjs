import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { createExperimentServer } from '../../src/http/app.mjs';
import { packageMedia } from '../../../media-cli/src/package-hls.mjs';

const exec = promisify(execFile);

async function startServer(t, { downlinkKbps = 100000 } = {}) {
  const resultsRoot = await mkdtemp(path.join(os.tmpdir(), 'abr-server-test-'));
  const source = path.join(resultsRoot, 'source.mp4');
  const packageRoot = path.join(resultsRoot, 'media');
  await exec('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=25:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ]);
  const packaged = await packageMedia({ source, output: packageRoot, preset: 'ultrafast', licenseClaim: 'generated integration fixture' });
  const scenario = {
    schemaVersion: '1.0.0', id: 'test-high-v1', description: 'test', status: 'frozen',
    clock: 'server-monotonic-since-run-start', rateUnit: 'decimal-kbit-per-second', responseStartDelayMs: 0,
    scheduler: { scope: 'per-run-aggregate-media-body', discipline: 'work-conserving-fifo', initialTokensBytes: 0, maxBurstBytes: 16384, maxChunkBytes: 4096 },
    phases: [{ id: 'high', startMs: 0, downlinkKbps }],
  };
  const runRoot = path.join(resultsRoot, 'runs');
  const experiment = { id: 'abr-under-uncertainty-v1', sha256: '1'.repeat(64), packageSha256: packaged.report.packageManifestSha256 };
  const service = await createExperimentServer({
    packageRoot, resultsRoot: runRoot,
    scenarios: new Map([[scenario.id, scenario]]),
    experiment,
  });
  const address = await service.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => { await service.close(); await rm(resultsRoot, { recursive: true, force: true }); });
  return { base: `http://${address.address}:${address.port}`, resultsRoot, runRoot, packageRoot, scenario, experiment, service };
}

async function jsonFetch(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  return { response, data };
}

test('lifecycle, idempotent telemetry, secure HLS and range behavior integrate', { timeout: 30000 }, async (t) => {
  const fixture = await startServer(t);
  const { base } = fixture;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  const createBody = {
    requestId: randomUUID(), experimentId: 'abr-under-uncertainty-v1', scenarioId: 'test-high-v1',
    policyId: 'default-hlsjs', repetition: 1, orderSeed: 20261109, clientLabel: 'test',
    gitCommit: '0'.repeat(40), gitDirty: true,
  };
  const invalidCreate = await fetch(`${base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...createBody, unexpected: true }) });
  assert.equal(invalidCreate.status, 422);
  const created = await jsonFetch(`${base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) });
  assert.equal(created.response.status, 201);
  const replay = await jsonFetch(`${base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(createBody) });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.data.runId, created.data.runId);
  const runId = created.data.runId;
  const invalidStart = await fetch(`${base}/api/v1/runs/${runId}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(invalidStart.status, 422);
  const started = await jsonFetch(`${base}/api/v1/runs/${runId}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientSendEpochMs: Date.now(), clientSendMonoMs: 1 }) });
  assert.equal(started.data.status, 'RUNNING');
  assert.deepEqual(Object.keys(started.data).sort(), [
    'hlsUrl', 'runId', 'scenarioId', 'scenarioSha256', 'serverReceiveEpochMs',
    'serverRunStartEpochMs', 'serverSendEpochMs', 'status',
  ]);
  assert.equal(started.data.hlsUrl, `/stream/v1/${runId}/master.m3u8`);
  assert.match(started.data.scenarioSha256, /^[0-9a-f]{64}$/);
  const prematureFinish = await fetch(`${base}/api/v1/runs/${runId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'ended', lastSeq: 0, clientSummary: {} }) });
  assert.equal(prematureFinish.status, 422);
  assert.equal((await jsonFetch(`${base}/api/v1/runs/${runId}`)).data.status, 'RUNNING');

  const master = await fetch(`${base}${started.data.hlsUrl}`);
  assert.equal(master.status, 200);
  assert.equal(master.headers.get('cache-control'), 'no-store');
  assert.match(await master.text(), new RegExp(`/stream/v1/${runId}/v0/index.m3u8`));

  const segmentUrl = `${base}/stream/v1/${runId}/v0/seg_00000.ts`;
  const head = await fetch(segmentUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.ok(Number(head.headers.get('content-length')) > 0);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const range = await fetch(segmentUrl, { headers: { Range: 'bytes=0-0' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 1);
  assert.match(range.headers.get('content-range'), /^bytes 0-0\//);
  const traversal = await fetch(`${base}/stream/v1/${runId}/%2e%2e%2fpackage.json`);
  assert.equal(traversal.status, 400);

  const event = {
    schemaVersion: '1.0.0', runId, source: 'player', seq: 0, type: 'client.ready',
    clientMonoMs: 1, clientEpochMs: Date.now(), data: { userAgent: 'test', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, hlsJsVersion: '1.7.4' },
  };
  const firstEvents = await jsonFetch(`${base}/api/v1/runs/${runId}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) });
  assert.deepEqual(firstEvents.data, { accepted: 1, duplicates: 0, highestSeqBySource: { player: 0 } });
  const duplicate = await jsonFetch(`${base}/api/v1/runs/${runId}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [event] }) });
  assert.equal(duplicate.data.duplicates, 1);
  const eventOne = { ...event, seq: 1, clientMonoMs: 2 };
  const duplicateInBatch = await jsonFetch(`${base}/api/v1/runs/${runId}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [eventOne, eventOne] }) });
  assert.deepEqual(duplicateInBatch.data, { accepted: 1, duplicates: 1, highestSeqBySource: { player: 1 } });
  const conflict = structuredClone(event); conflict.data.userAgent = 'different';
  const conflictResponse = await fetch(`${base}/api/v1/runs/${runId}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [conflict] }) });
  assert.equal(conflictResponse.status, 409);

  const invalidFinish = await fetch(`${base}/api/v1/runs/${runId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'made_up', lastSeq: 1, clientSummary: {} }) });
  assert.equal(invalidFinish.status, 422);
  const finished = await jsonFetch(`${base}/api/v1/runs/${runId}/finish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'ended', lastSeq: 1, clientSummary: {} }) });
  assert.equal(finished.data.status, 'COMPLETED');
  const evidence = (await readFile(path.join(fixture.runRoot, runId, 'events.ndjson'), 'utf8')).trim().split('\n');
  assert.equal(evidence.length, 2);
  assert.equal((await fetch(segmentUrl)).status, 409);
});

test('a server restart deterministically fails an active run without resetting run zero', { timeout: 30000 }, async (t) => {
  const fixture = await startServer(t);
  const created = await jsonFetch(`${fixture.base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    requestId: randomUUID(), experimentId: fixture.experiment.id, scenarioId: fixture.scenario.id,
    policyId: 'default-hlsjs', repetition: 1, orderSeed: 9, clientLabel: 'restart-test',
    gitCommit: 'b'.repeat(40), gitDirty: false,
  }) });
  const runId = created.data.runId;
  const started = await jsonFetch(`${fixture.base}/api/v1/runs/${runId}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientSendEpochMs: Date.now(), clientSendMonoMs: 1 }) });
  await fixture.service.close();

  const restarted = await createExperimentServer({
    packageRoot: fixture.packageRoot, resultsRoot: fixture.runRoot,
    scenarios: new Map([[fixture.scenario.id, fixture.scenario]]), experiment: fixture.experiment,
  });
  t.after(() => restarted.close());
  const address = await restarted.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://${address.address}:${address.port}`;
  const state = await jsonFetch(`${base}/api/v1/runs/${runId}`);
  assert.equal(state.data.serverRunStartEpochMs, started.data.serverRunStartEpochMs);
  assert.equal(state.data.status, 'FAILED');
  assert.equal(state.data.failureCode, 'SERVER_RESTART');
  const master = await fetch(`${base}/stream/v1/${runId}/master.m3u8`);
  assert.equal(master.status, 409);
});

test('aborting a run terminates active and queued media transfers', { timeout: 30000 }, async (t) => {
  const fixture = await startServer(t, { downlinkKbps: 64 });
  const created = await jsonFetch(`${fixture.base}/api/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    requestId: randomUUID(), experimentId: fixture.experiment.id, scenarioId: fixture.scenario.id,
    policyId: 'default-hlsjs', repetition: 1, orderSeed: 10, clientLabel: 'abort-test',
    gitCommit: 'c'.repeat(40), gitDirty: false,
  }) });
  const runId = created.data.runId;
  await jsonFetch(`${fixture.base}/api/v1/runs/${runId}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ clientSendEpochMs: Date.now(), clientSendMonoMs: 1 }) });
  const segmentUrl = `${fixture.base}/stream/v1/${runId}/v3/seg_00000.ts`;
  const consume = async () => {
    try { const response = await fetch(segmentUrl); await response.arrayBuffer(); return { completed: response.ok }; }
    catch { return { completed: false }; }
  };
  const transfers = [consume(), consume()];
  await new Promise((resolve) => setTimeout(resolve, 100));
  const aborted = await jsonFetch(`${fixture.base}/api/v1/runs/${runId}/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'test abort' }) });
  assert.equal(aborted.data.status, 'ABORTED');
  const results = await Promise.race([
    Promise.all(transfers),
    new Promise((_, reject) => setTimeout(() => reject(new Error('transfers did not terminate after abort')), 3000)),
  ]);
  assert.equal(results.every((result) => result.completed === false), true);
});

test('readiness rejects a missing or unverifiable media payload', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'abr-not-ready-test-'));
  const packageRoot = path.join(root, 'media');
  await mkdir(packageRoot);
  const scenario = {
    schemaVersion: '1.0.0', id: 'test-v1', description: 'test', status: 'frozen',
    clock: 'server-monotonic-since-run-start', rateUnit: 'decimal-kbit-per-second', responseStartDelayMs: 0,
    scheduler: { scope: 'per-run-aggregate-media-body', discipline: 'work-conserving-fifo', initialTokensBytes: 0, maxBurstBytes: 16384, maxChunkBytes: 4096 },
    phases: [{ id: 'high', startMs: 0, downlinkKbps: 1000 }],
  };
  const service = await createExperimentServer({
    packageRoot, resultsRoot: path.join(root, 'runs'), scenarios: new Map([[scenario.id, scenario]]),
    experiment: { id: 'abr-under-uncertainty-v1', sha256: '1'.repeat(64), packageSha256: '2'.repeat(64) },
  });
  t.after(async () => { await service.close(); await rm(root, { recursive: true, force: true }); });
  const address = await service.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://${address.address}:${address.port}`;
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
});
