// MOCK ONLY: replaces Member 1's lifecycle API during isolated player work.
const SHA = '0'.repeat(64);

function uuidV7Like() {
  const hex = Date.now().toString(16).padStart(12, '0').slice(-12);
  const random = crypto.getRandomValues(new Uint8Array(10));
  const tail = [...random].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18)}`;
}

export class MockRunApi {
  constructor() { this.runs = new Map(); }

  async createRun(input) {
    const runId = `r_${uuidV7Like()}`;
    const run = { schemaVersion: '1.0.0', runId, requestId: input.requestId, status: 'CREATED', experimentId: input.experimentId,
      experimentSha256: SHA, scenarioId: input.scenarioId, scenarioSha256: SHA, packageSha256: SHA, repetition: input.repetition,
      policyId: input.policyId, orderSeed: input.orderSeed, clientLabel: input.clientLabel, gitCommit: input.gitCommit, gitDirty: input.gitDirty,
      createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, finishReason: null, warnings: ['MOCK API: no media server is connected'] };
    this.runs.set(runId, { run, events: new Map() });
    return run;
  }

  async startRun(runId) {
    const stored = this.require(runId);
    stored.run.status = 'RUNNING'; stored.run.startedAt ??= new Date().toISOString();
    return { runId, status: 'RUNNING', hlsUrl: `/mock/stream/${runId}/master.m3u8`, serverRunStartEpochMs: Date.now(),
      serverReceiveEpochMs: Date.now(), serverSendEpochMs: Date.now(), scenarioId: stored.run.scenarioId, scenarioSha256: SHA };
  }

  async appendEvents(runId, { events }) {
    const stored = this.require(runId); let accepted = 0; let duplicates = 0;
    for (const event of events) {
      if (stored.events.has(event.seq)) duplicates += 1;
      else { stored.events.set(event.seq, event); accepted += 1; }
    }
    return { accepted, duplicates, highestSeqBySource: { player: Math.max(-1, ...stored.events.keys()) } };
  }

  async finishRun(runId, input) {
    const stored = this.require(runId);
    stored.run.status = 'COMPLETED'; stored.run.finishedAt = new Date().toISOString(); stored.run.finishReason = input.reason;
    return stored.run;
  }

  async abortRun(runId, input) {
    const stored = this.require(runId);
    stored.run.status = 'ABORTED'; stored.run.finishedAt = new Date().toISOString(); stored.run.finishReason = input.reason;
    return stored.run;
  }

  eventsFor(runId) { return [...this.require(runId).events.values()].sort((a, b) => a.seq - b.seq); }
  require(runId) { const stored = this.runs.get(runId); if (!stored) throw new Error(`MOCK run not found: ${runId}`); return stored; }
}
