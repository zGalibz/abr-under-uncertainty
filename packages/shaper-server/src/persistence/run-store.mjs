import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalize, sha256Canonical } from '../domain/canonical-json.mjs';
import { createUuidV7Generator, formatRunId } from '../domain/uuid-v7.mjs';
import { writeAtomic } from '../platform/atomic-files.mjs';

const iso = () => new Date().toISOString();
const hashFile = async (file) => createHash('sha256').update(await readFile(file)).digest('hex');

export class RunStore {
  constructor({ root, scenarios, experiment }) {
    this.root = root;
    this.scenarios = scenarios;
    this.experiment = experiment;
    this.generator = createUuidV7Generator();
    this.runs = new Map();
    this.requests = new Map();
    this.eventIndexes = new Map();
    this.queues = new Map();
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    for (const name of await readdir(this.root).catch(() => [])) {
      if (!name.startsWith('r_')) continue;
      try {
        const run = JSON.parse(await readFile(path.join(this.root, name, 'run.json'), 'utf8'));
        if (run.status === 'RUNNING' || run.status === 'FINALIZING') {
          run.status = 'FAILED'; run.failureCode = 'SERVER_RESTART'; run.finishedAt = iso();
          await this.#persist(run);
        }
        this.runs.set(run.runId, run);
        this.requests.set(run.requestId, { fingerprint: run.createFingerprint, runId: run.runId });
      } catch { /* retain unreadable directories for operator inspection */ }
    }
  }

  async create(body) {
    const fingerprint = sha256Canonical(body);
    const known = this.requests.get(body.requestId);
    if (known) {
      if (known.fingerprint !== fingerprint) throw Object.assign(new Error('requestId reused with different body'), { code: 'IDEMPOTENCY_CONFLICT', status: 409 });
      return { created: false, run: this.runs.get(known.runId) };
    }
    const scenario = this.scenarios.get(body.scenarioId);
    if (!scenario) throw Object.assign(new Error('unknown scenario'), { code: 'SCENARIO_NOT_FOUND', status: 422 });
    if (scenario.status !== 'frozen') throw Object.assign(new Error('scenario is not frozen'), { code: 'SCENARIO_NOT_FROZEN', status: 422 });
    if (body.experimentId !== this.experiment.id) throw Object.assign(new Error('experiment mismatch'), { code: 'EXPERIMENT_MISMATCH', status: 422 });
    const runId = formatRunId(this.generator.next());
    const run = {
      schemaVersion: '1.0.0', runId, requestId: body.requestId, status: 'CREATED', experimentId: body.experimentId,
      experimentSha256: this.experiment.sha256, scenarioId: body.scenarioId, scenarioSha256: sha256Canonical(scenario), packageSha256: this.experiment.packageSha256,
      policyId: body.policyId, repetition: body.repetition, orderSeed: body.orderSeed, clientLabel: body.clientLabel,
      gitCommit: body.gitCommit, gitDirty: body.gitDirty, createdAt: iso(), startedAt: null, finishedAt: null,
      finishReason: null, failureCode: null, warnings: [], artifacts: {}, startRequest: null,
      serverRunStartEpochMs: null, serverRunStartMonoMs: null, createFingerprint: fingerprint,
    };
    await this.#persist(run);
    this.runs.set(runId, run);
    this.requests.set(body.requestId, { fingerprint, runId });
    return { created: true, run };
  }

  get(runId) { return this.runs.get(runId) ?? null; }

  async start(runId, request, { epochMs, monoMs }) {
    const run = this.#require(runId);
    const fingerprint = sha256Canonical(request);
    if (run.status === 'RUNNING') {
      if (run.startFingerprint !== fingerprint) throw this.#conflict('start replay differs');
      return run;
    }
    if (run.status !== 'CREATED') throw this.#conflict('run cannot start');
    Object.assign(run, { status: 'RUNNING', startedAt: new Date(epochMs).toISOString(), startRequest: request, startFingerprint: fingerprint, serverRunStartEpochMs: epochMs, serverRunStartMonoMs: monoMs });
    await this.#persist(run);
    return run;
  }

  async appendEvents(runId, events) {
    return this.#serialize(runId, async () => {
      const run = this.#require(runId);
      if (run.status !== 'RUNNING') throw this.#conflict('events require RUNNING');
      let index = this.eventIndexes.get(runId);
      if (!index) index = await this.#loadEventIndex(runId);
      const novel = [];
      let duplicates = 0;
      const batchSeen = new Map();
      for (const event of events) {
        if (event.runId !== runId) throw Object.assign(new Error('event run mismatch'), { code: 'EVENT_RUN_MISMATCH', status: 422 });
        const key = `${event.source}:${event.seq}`;
        const fingerprint = sha256Canonical(event);
        if (batchSeen.has(key)) {
          if (batchSeen.get(key) !== fingerprint) throw Object.assign(new Error('event identity conflict within batch'), { code: 'EVENT_IDENTITY_CONFLICT', status: 409 });
          duplicates += 1;
          continue;
        }
        batchSeen.set(key, fingerprint);
        if (index.has(key)) {
          if (index.get(key) !== fingerprint) throw Object.assign(new Error('event identity conflict'), { code: 'EVENT_IDENTITY_CONFLICT', status: 409 });
          duplicates += 1;
        } else novel.push({ event, key, fingerprint });
      }
      if (novel.length) {
        const file = path.join(this.root, runId, 'events.ndjson');
        await appendFile(file, novel.map(({ event }) => `${canonicalize(event)}\n`).join(''), { encoding: 'utf8', flush: true });
        novel.forEach(({ key, fingerprint }) => index.set(key, fingerprint));
      }
      this.eventIndexes.set(runId, index);
      const highest = {};
      for (const key of index.keys()) { const [source, seq] = key.split(':'); highest[source] = Math.max(highest[source] ?? -1, Number(seq)); }
      return { accepted: novel.length, duplicates, highestSeqBySource: highest };
    });
  }

  async finish(runId, body) {
    return this.#serialize(runId, async () => {
      const run = this.#require(runId);
      const fingerprint = sha256Canonical(body);
      if (run.status === 'COMPLETED') {
        if (run.finishFingerprint !== fingerprint) throw this.#conflict('finish replay differs');
        return run;
      }
      if (run.status !== 'RUNNING') throw this.#conflict('finish requires RUNNING');
      await this.#validateTelemetryComplete(runId, body);
      run.status = 'FINALIZING'; await this.#persist(run);
      const eventsFile = path.join(this.root, runId, 'events.ndjson');
      const requestsFile = path.join(this.root, runId, 'server-requests.ndjson');
      const schedulerFile = path.join(this.root, runId, 'scheduler-writes.ndjson');
      for (const [name, file] of [['events.ndjson', eventsFile], ['server-requests.ndjson', requestsFile], ['scheduler-writes.ndjson', schedulerFile]]) {
        try { run.artifacts[name] = await hashFile(file); } catch { run.warnings.push(`${name} missing`); }
      }
      Object.assign(run, { status: 'COMPLETED', finishedAt: iso(), finishReason: body.reason, finishFingerprint: fingerprint });
      await this.#persist(run);
      return run;
    });
  }

  async validateFinish(runId, body) {
    const run = this.#require(runId);
    if (run.status !== 'RUNNING') throw this.#conflict('finish requires RUNNING');
    await this.#validateTelemetryComplete(runId, body);
  }

  async abort(runId, body) {
    const run = this.#require(runId);
    const fingerprint = sha256Canonical(body);
    if (run.status === 'ABORTED') {
      if (run.abortFingerprint !== fingerprint) throw this.#conflict('abort replay differs');
      return run;
    }
    if (!['CREATED', 'RUNNING'].includes(run.status)) throw this.#conflict('run cannot abort');
    Object.assign(run, { status: 'ABORTED', finishedAt: iso(), finishReason: body.reason, abortFingerprint: fingerprint });
    await this.#persist(run);
    return run;
  }

  async appendLog(runId, name, record) {
    await mkdir(path.join(this.root, runId), { recursive: true });
    await appendFile(path.join(this.root, runId, name), `${canonicalize(record)}\n`, { encoding: 'utf8' });
  }

  async #loadEventIndex(runId) {
    const index = new Map();
    try {
      const lines = (await readFile(path.join(this.root, runId, 'events.ndjson'), 'utf8')).split('\n').filter(Boolean);
      for (const line of lines) { const event = JSON.parse(line); index.set(`${event.source}:${event.seq}`, sha256Canonical(event)); }
    } catch { /* no event file yet */ }
    return index;
  }

  async #validateTelemetryComplete(runId, body) {
    if (!Number.isSafeInteger(body.lastSeq) || body.lastSeq < 0) throw Object.assign(new Error('lastSeq must be a non-negative integer'), { code: 'VALIDATION_ERROR', status: 422 });
    const eventIndex = this.eventIndexes.get(runId) ?? await this.#loadEventIndex(runId);
    const playerSeqs = [...eventIndex.keys()].filter((key) => key.startsWith('player:')).map((key) => Number(key.slice('player:'.length))).sort((a, b) => a - b);
    const complete = playerSeqs.length === body.lastSeq + 1 && playerSeqs.every((seq, index) => seq === index);
    if (!complete) throw Object.assign(new Error(`player telemetry must contain every sequence from 0 through ${body.lastSeq}`), { code: 'TELEMETRY_INCOMPLETE', status: 422 });
  }

  #require(runId) { const run = this.get(runId); if (!run) throw Object.assign(new Error('run not found'), { code: 'RUN_NOT_FOUND', status: 404 }); return run; }
  #conflict(message) { return Object.assign(new Error(message), { code: 'RUN_STATE_CONFLICT', status: 409 }); }
  async #persist(run) { await writeAtomic(path.join(this.root, run.runId, 'run.json'), `${JSON.stringify(run, null, 2)}\n`); }
  #serialize(key, action) { const before = this.queues.get(key) ?? Promise.resolve(); const next = before.then(action, action); this.queues.set(key, next.catch(() => {})); return next; }
}
