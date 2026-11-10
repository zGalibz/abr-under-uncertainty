const MAX_EVENTS_PER_BATCH = 200;

function assertFinite(value, name) {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}

function plainData(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('telemetry data must be a plain object');
  return JSON.parse(JSON.stringify(data, (_key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    if (typeof value === 'object' && value !== null && (value instanceof Error || value instanceof Event)) throw new Error('telemetry data cannot contain platform objects');
    return value;
  }));
}

/**
 * Appends contract-shaped player events and safely retries the same sequence
 * numbers. The transport must implement appendEvents(runId, {events}).
 */
export class TelemetryClient {
  constructor({ runId, transport, monoNow = () => performance.now(), epochNow = () => Date.now(), onEvent = () => {}, batchSize = 50, flushIntervalMs = 1000 }) {
    if (!runId) throw new Error('runId is required');
    this.runId = runId;
    this.transport = transport;
    this.monoNow = monoNow;
    this.epochNow = epochNow;
    this.onEvent = onEvent;
    this.batchSize = Math.min(Math.max(1, batchSize), MAX_EVENTS_PER_BATCH);
    this.pending = [];
    this.nextSeq = 0;
    this.lastMonoMs = 0;
    this.inFlight = null;
    this.failed = null;
    this.timer = setInterval(() => { void this.flush(); }, flushIntervalMs);
  }

  emit(type, data, mediaTimeSec) {
    const sampledMonoMs = assertFinite(this.monoNow(), 'clientMonoMs');
    const clientMonoMs = Math.max(this.lastMonoMs, sampledMonoMs);
    this.lastMonoMs = clientMonoMs;
    const event = {
      schemaVersion: '1.0.0',
      runId: this.runId,
      source: 'player',
      seq: this.nextSeq++,
      type,
      clientMonoMs,
      clientEpochMs: assertFinite(this.epochNow(), 'clientEpochMs'),
      data: plainData(data),
    };
    if (mediaTimeSec !== undefined) event.mediaTimeSec = Math.max(0, assertFinite(mediaTimeSec, 'mediaTimeSec'));
    this.pending.push(event);
    this.onEvent(event);
    if (this.pending.length >= this.batchSize) void this.flush().catch(() => {});
    return event;
  }

  async flush() {
    if (this.inFlight || this.pending.length === 0) return this.inFlight;
    const batch = this.pending.splice(0, MAX_EVENTS_PER_BATCH);
    this.inFlight = Promise.resolve()
      .then(() => this.transport.appendEvents(this.runId, { events: batch }))
      .catch((error) => {
        this.pending.unshift(...batch);
        this.failed = error;
        throw error;
      })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async flushAll({ retries = 3 } = {}) {
    let attempts = 0;
    while (this.pending.length > 0 || this.inFlight) {
      try {
        await this.flush();
      } catch (error) {
        attempts += 1;
        if (attempts > retries) throw error;
      }
    }
  }

  async close(options) {
    clearInterval(this.timer);
    await this.flushAll(options);
  }
}

export function forwardBufferSeconds(video, epsilon = 0.05) {
  const time = Number(video.currentTime) || 0;
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    const start = ranges.start(index);
    const end = ranges.end(index);
    if (start - epsilon <= time && time <= end + epsilon) return Math.max(0, end - time);
  }
  return 0;
}

export function playbackQuality(video) {
  const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
  return {
    droppedVideoFrames: Math.max(0, Number(quality?.droppedVideoFrames) || 0),
    totalVideoFrames: Math.max(0, Number(quality?.totalVideoFrames) || 0),
  };
}
