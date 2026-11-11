import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { RunStore } from '../persistence/run-store.mjs';
import { compileSchedule } from '../domain/scenario.mjs';
import { createAssetResolver } from '../platform/safe-asset-resolver.mjs';
import { verifyPackagePayload } from '../platform/package-readiness.mjs';
import { rewritePlaylist } from '../domain/playlist-rewriter.mjs';
import { parseSingleRange } from '../domain/range.mjs';
import { FifoScheduler, systemClock } from '../shaping/fifo-scheduler.mjs';

const telemetrySchemaPath = fileURLToPath(new URL('../../../../contracts/schemas/telemetry-event.schema.json', import.meta.url));
const MIME = { '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8', '.ts': 'video/mp2t' };
const lifecycleSchemas = {
  create: {
    type: 'object', additionalProperties: false,
    required: ['requestId', 'experimentId', 'scenarioId', 'policyId', 'repetition', 'orderSeed', 'clientLabel', 'gitCommit', 'gitDirty'],
    properties: {
      requestId: { type: 'string', format: 'uuid' }, experimentId: { type: 'string', minLength: 1 }, scenarioId: { type: 'string', minLength: 1 },
      policyId: { enum: ['default-hlsjs', 'conservative-throughput-v1'] }, repetition: { type: 'integer', minimum: 1 },
      orderSeed: { type: 'integer', minimum: 0, maximum: 4294967295 }, clientLabel: { type: 'string', minLength: 1, maxLength: 100 },
      gitCommit: { type: 'string', pattern: '^[0-9a-f]{40}$' }, gitDirty: { type: 'boolean' },
    },
  },
  start: { type: 'object', additionalProperties: false, required: ['clientSendEpochMs', 'clientSendMonoMs'], properties: { clientSendEpochMs: { type: 'number', minimum: 0 }, clientSendMonoMs: { type: 'number', minimum: 0 } } },
  finish: { type: 'object', additionalProperties: false, required: ['reason', 'lastSeq', 'clientSummary'], properties: { reason: { enum: ['ended', 'fatal_error', 'timeout', 'aborted'] }, lastSeq: { type: 'integer', minimum: 0 }, clientSummary: { type: 'object' } } },
  abort: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
};

function publicRun(run) {
  return Object.fromEntries(Object.entries(run).filter(([key]) => !key.endsWith('Fingerprint')));
}

function apiError(error) {
  return { status: error.status ?? 500, code: error.code ?? 'INTERNAL_ERROR', message: error.status ? error.message : 'Internal server error' };
}

function sendJson(response, status, value) {
  const body = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(body);
}

async function readJsonBody(request, maxBytes = 1024 * 1024) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) throw Object.assign(new Error('application/json required'), { code: 'CONTENT_TYPE_REQUIRED', status: 415 });
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('body exceeds 1 MiB'), { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('invalid JSON'), { code: 'INVALID_JSON', status: 400 }); }
}

function streamMatch(rawUrl) {
  const pathOnly = rawUrl.split('?')[0];
  const match = /^\/stream\/v1\/(r_[0-9a-f-]+)\/(.+)$/.exec(pathOnly);
  return match ? { runId: match[1], rawAsset: match[2], hasQuery: rawUrl.includes('?') } : null;
}

export async function createExperimentServer({ packageRoot, resultsRoot, scenarios, experiment, clock = systemClock }) {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validateEvent = ajv.compile(JSON.parse(await readFile(telemetrySchemaPath, 'utf8')));
  const validators = Object.fromEntries(Object.entries(lifecycleSchemas).map(([name, schema]) => [name, ajv.compile(schema)]));
  const validateLifecycle = (name, body) => {
    if (!validators[name](body)) throw Object.assign(new Error(ajv.errorsText(validators[name].errors)), { code: 'VALIDATION_ERROR', status: 422 });
  };
  const resolver = await createAssetResolver({ packageRoot });
  const readiness = await verifyPackagePayload({ packageRoot, expectedManifestSha256: experiment.packageSha256 });
  const store = new RunStore({ root: resultsRoot, scenarios, experiment });
  await store.initialize();
  const schedulers = new Map();
  const requestSeq = new Map();
  const schedulerSeq = new Map();

  function next(map, runId) { const value = map.get(runId) ?? 0; map.set(runId, value + 1); return value; }

  async function handleStream(request, response, match) {
    if (match.hasQuery) throw Object.assign(new Error('stream queries are unsupported'), { code: 'STREAM_QUERY_UNSUPPORTED', status: 400 });
    const run = store.get(match.runId);
    if (!run) throw Object.assign(new Error('run not found'), { code: 'RUN_NOT_FOUND', status: 404 });
    if (run.status !== 'RUNNING') throw Object.assign(new Error('run is not running'), { code: 'RUN_NOT_RUNNING', status: 409 });
    if (!['GET', 'HEAD'].includes(request.method)) { response.setHeader('allow', 'GET, HEAD'); throw Object.assign(new Error('method not allowed'), { code: 'METHOD_NOT_ALLOWED', status: 405 }); }
    if (request.headers['if-range'] !== undefined) throw Object.assign(new Error('If-Range unsupported'), { code: 'IF_RANGE_UNSUPPORTED', status: 400 });
    const asset = await resolver.resolve(match.rawAsset);
    if (!(asset.extension in MIME)) throw Object.assign(new Error('unsupported asset type'), { code: 'ASSET_TYPE_UNSUPPORTED', status: 400 });
    let representation = await readFile(asset.realPath);
    if (asset.extension === '.m3u8') representation = Buffer.from(rewritePlaylist({ text: representation.toString('utf8'), playlistRelativePath: asset.relativePath, runId: match.runId }));
    const selected = parseSingleRange(request.headers.range, representation.length);
    if (selected.kind === 'malformed') throw Object.assign(new Error('unsupported range'), { code: selected.code, status: 400 });
    if (selected.kind === 'unsatisfiable') {
      response.setHeader('content-range', `bytes */${representation.length}`);
      throw Object.assign(new Error('range not satisfiable'), { code: selected.code, status: 416 });
    }
    const body = representation.subarray(selected.start, selected.end + 1);
    const status = selected.kind === 'partial' ? 206 : 200;
    response.setHeader('content-type', MIME[asset.extension]);
    response.setHeader('content-length', body.length);
    response.setHeader('accept-ranges', 'bytes');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-run-id', match.runId);
    if (selected.kind === 'partial') response.setHeader('content-range', `bytes ${selected.start}-${selected.end}/${representation.length}`);
    if (request.method === 'HEAD') { response.writeHead(status); response.end(); return; }
    if (asset.extension === '.m3u8') { response.writeHead(status); response.end(body); return; }

    const scheduler = schedulers.get(match.runId);
    if (!scheduler) throw Object.assign(new Error('run scheduler unavailable'), { code: 'SCHEDULER_UNAVAILABLE', status: 409 });
    const seq = next(requestSeq, match.runId);
    const acceptedMonoMs = clock.nowMonoMs();
    const acceptedAtRunMs = acceptedMonoMs - run.serverRunStartMonoMs;
    const phaseAtAccept = scenarios.get(run.scenarioId).phases.find((phase) => acceptedAtRunMs >= phase.startMs && (phase.endMs === undefined || acceptedAtRunMs < phase.endMs))?.id ?? null;
    const abortController = new AbortController();
    request.once('aborted', () => abortController.abort());
    let result;
    try {
      result = await scheduler.enqueue({
        requestSeq: seq, acceptedMonoMs, buffer: body, writable: response, signal: abortController.signal,
        beforeFirstWrite: async (phase) => { response.statusCode = status; response.setHeader('x-scenario-phase', phase.id); },
      });
      response.end();
    } catch (error) {
      if (!response.headersSent) throw error;
      response.destroy();
      result = { bytesWritten: 0, firstByteAtRunMs: null, lastByteAtRunMs: clock.nowMonoMs() - run.serverRunStartMonoMs, aborted: true };
    } finally {
      await store.appendLog(match.runId, 'server-requests.ndjson', {
        schemaVersion: '1.0.0', runId: match.runId, requestSeq: seq, method: request.method, path: asset.relativePath,
        range: request.headers.range ?? null, status, phaseAtAccept, acceptedAtRunMs, eligibleAtRunMs: acceptedAtRunMs + scenarios.get(run.scenarioId).responseStartDelayMs,
        firstByteAtRunMs: result?.firstByteAtRunMs ?? null, lastByteAtRunMs: result?.lastByteAtRunMs ?? null,
        representationBytes: representation.length, bodyBytesWritten: result?.bytesWritten ?? 0,
        aborted: result?.aborted ?? false, abortCode: result?.aborted ? 'CLIENT_ABORT' : null, backpressureWaitMs: 0,
      });
    }
  }

  const server = createServer(async (request, response) => {
    try {
      const rawUrl = request.url ?? '/';
      if (request.method === 'GET' && rawUrl === '/healthz') { sendJson(response, 200, { status: 'ok' }); return; }
      if (request.method === 'GET' && rawUrl === '/readyz') {
        if (readiness.ready) sendJson(response, 200, { status: 'ready' });
        else sendJson(response, 503, { code: 'NOT_READY', message: readiness.error });
        return;
      }
      if (!readiness.ready) throw Object.assign(new Error(readiness.error), { code: 'NOT_READY', status: 503 });
      const stream = streamMatch(rawUrl);
      if (stream) { await handleStream(request, response, stream); return; }
      if (request.method === 'POST' && rawUrl === '/api/v1/runs') {
        const body = await readJsonBody(request); validateLifecycle('create', body);
        const result = await store.create(body); sendJson(response, result.created ? 201 : 200, publicRun(result.run)); return;
      }
      const runRoute = /^\/api\/v1\/runs\/(r_[0-9a-f-]+)(?:\/(start|events|finish|abort))?$/.exec(rawUrl);
      if (runRoute) {
        const [, runId, action] = runRoute;
        if (!action && request.method === 'GET') { const run = store.get(runId); if (!run) throw Object.assign(new Error('run not found'), { code: 'RUN_NOT_FOUND', status: 404 }); sendJson(response, 200, publicRun(run)); return; }
        if (request.method !== 'POST') throw Object.assign(new Error('method not allowed'), { code: 'METHOD_NOT_ALLOWED', status: 405 });
        const body = await readJsonBody(request);
        if (action === 'start') {
          validateLifecycle('start', body);
          const epochMs = Date.now(); const monoMs = clock.nowMonoMs();
          const run = await store.start(runId, body, { epochMs, monoMs });
          if (!schedulers.has(runId)) {
            const scenario = scenarios.get(run.scenarioId); const schedule = compileSchedule(scenario);
            schedulers.set(runId, new FifoScheduler({
              clock, schedule, startMonoMs: run.serverRunStartMonoMs, maxBurstBytes: scenario.scheduler.maxBurstBytes,
              maxChunkBytes: scenario.scheduler.maxChunkBytes, responseStartDelayMs: scenario.responseStartDelayMs,
              logger: async (record) => store.appendLog(runId, 'scheduler-writes.ndjson', { schemaVersion: '1.0.0', runId, seq: next(schedulerSeq, runId), requestSeq: record.requestSeq ?? null, phaseId: record.phaseId ?? null, targetKbps: record.targetKbps ?? null, bytes: record.bytes ?? 0, cumulativeRunBytes: record.cumulativeRunBytes ?? 0, atRunMs: record.atRunMs, kind: record.kind, writeAccepted: record.writeAccepted ?? null, tokensBefore: null, tokensAfter: null, plannedWakeAtRunMs: null }),
            }));
          }
          sendJson(response, 200, { runId, status: 'RUNNING', hlsUrl: `/stream/v1/${runId}/master.m3u8`, serverRunStartEpochMs: run.serverRunStartEpochMs, serverReceiveEpochMs: epochMs, serverSendEpochMs: Date.now(), scenarioId: run.scenarioId, scenarioSha256: run.scenarioSha256 }); return;
        }
        if (action === 'events') {
          if (!body || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 200) throw Object.assign(new Error('events must contain 1..200 items'), { code: 'VALIDATION_ERROR', status: 422 });
          for (const event of body.events) if (!validateEvent(event)) throw Object.assign(new Error(ajv.errorsText(validateEvent.errors)), { code: 'VALIDATION_ERROR', status: 422 });
          sendJson(response, 202, await store.appendEvents(runId, body.events)); return;
        }
        if (action === 'finish') { validateLifecycle('finish', body); await store.validateFinish(runId, body); const scheduler = schedulers.get(runId); if (scheduler) { await scheduler.idle(); scheduler.close(); } sendJson(response, 200, publicRun(await store.finish(runId, body))); return; }
        if (action === 'abort') { validateLifecycle('abort', body); const scheduler = schedulers.get(runId); scheduler?.close({ abort: true }); sendJson(response, 200, publicRun(await store.abort(runId, body))); return; }
      }
      throw Object.assign(new Error('route not found'), { code: 'NOT_FOUND', status: 404 });
    } catch (error) {
      const formatted = apiError(error);
      if (!response.headersSent) sendJson(response, formatted.status, { code: formatted.code, message: formatted.message });
      else response.destroy();
    }
  });

  return {
    store,
    async listen({ host = '127.0.0.1', port = 8080 } = {}) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return server.address();
    },
    async close() {
      for (const scheduler of schedulers.values()) scheduler.close({ abort: true });
      await Promise.all([...schedulers.values()].map((scheduler) => scheduler.idle().catch(() => {})));
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}
