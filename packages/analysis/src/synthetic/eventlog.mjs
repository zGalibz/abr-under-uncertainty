// Helpers for building contract-shaped fake telemetry. Used by the synthetic
// dataset simulator and by the hand-written test fixtures.

export const EPOCH_BASE_MS = 1794196800000; // fixed so fake data is reproducible

// Small deterministic PRNG (mulberry32): same seed → same "random" run.
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Deterministic run ID in the contract's r_<uuidv7> shape.
export function fakeRunId(seed) {
  const r = rng(seed);
  const hex = (n) => Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join('');
  const ts = (EPOCH_BASE_MS + seed).toString(16).padStart(12, '0').slice(-12);
  const variant = '89ab'[Math.floor(r() * 4)];
  return `r_${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

// Placeholder four-level ladder until Galib's measured package exists.
export const PLACEHOLDER_LADDER = [
  { level: 0, width: 640, height: 360, bitrateBps: 800000, averageBitrateBps: 760000, codecs: 'avc1.64001e,mp4a.40.2' },
  { level: 1, width: 854, height: 480, bitrateBps: 1400000, averageBitrateBps: 1330000, codecs: 'avc1.64001f,mp4a.40.2' },
  { level: 2, width: 1280, height: 720, bitrateBps: 2800000, averageBitrateBps: 2650000, codecs: 'avc1.64001f,mp4a.40.2' },
  { level: 3, width: 1920, height: 1080, bitrateBps: 5000000, averageBitrateBps: 4700000, codecs: 'avc1.640028,mp4a.40.2' },
];

const round = (x) => Math.round(x * 1000) / 1000;

export class EventLog {
  constructor(runId) {
    this.runId = runId;
    this.pending = [];
  }

  emit(tMs, type, data, mediaTimeSec) {
    this.pending.push({ tMs, order: this.pending.length, type, data, mediaTimeSec });
  }

  // Sorts by time (stable), then assigns gap-free sequence numbers.
  finalize() {
    return this.pending
      .sort((a, b) => a.tMs - b.tMs || a.order - b.order)
      .map((p, seq) => {
        const e = {
          schemaVersion: '1.0.0',
          runId: this.runId,
          source: 'player',
          seq,
          type: p.type,
          clientMonoMs: round(p.tMs),
          clientEpochMs: round(EPOCH_BASE_MS + p.tMs),
        };
        if (p.mediaTimeSec !== undefined) e.mediaTimeSec = round(p.mediaTimeSec);
        e.data = p.data;
        return e;
      });
  }
}

export const toNdjson = (events) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;

export const clientReadyData = () => ({
  userAgent: 'synthetic/1.0',
  viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
  hlsJsVersion: '1.7.4',
});

export const urlPath = (runId, level, sn) => `/stream/v1/${runId}/v${level}/seg_${sn}.ts`;
