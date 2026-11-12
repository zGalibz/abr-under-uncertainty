import { once } from 'node:events';
import { TokenLedger } from './token-ledger.mjs';

function abortError() {
  const error = new Error('transfer aborted');
  error.name = 'AbortError';
  return error;
}

// A response whose connection is gone never emits 'drain'. The scheduler is
// one FIFO per run, so waiting on it would starve every later response of the
// run; treat a closed response as aborted instead.
async function drainOrClose(writable, signal) {
  if (writable.destroyed) throw abortError();
  const closed = new AbortController();
  const onClose = () => closed.abort();
  writable.once('close', onClose);
  try {
    await once(writable, 'drain', { signal: AbortSignal.any([signal, closed.signal].filter(Boolean)) });
  } catch (error) {
    throw error?.name === 'AbortError' ? abortError() : error;
  } finally {
    writable.off('close', onClose);
  }
}

export class FifoScheduler {
  constructor({ clock, schedule, startMonoMs, maxBurstBytes, maxChunkBytes, responseStartDelayMs, logger = async () => {} }) {
    this.clock = clock;
    this.schedule = schedule;
    this.startMonoMs = startMonoMs;
    this.maxChunkBytes = maxChunkBytes;
    this.responseStartDelayMs = responseStartDelayMs;
    this.logger = logger;
    this.ledger = new TokenLedger({ schedule, maxBurstBytes, startMonoMs });
    this.tail = Promise.resolve();
    this.closed = false;
    this.abortController = new AbortController();
    this.cumulativeBytes = 0;
  }

  enqueue(job) {
    if (this.closed) return Promise.reject(new Error('scheduler is closed'));
    const signals = [this.abortController.signal, job.signal].filter(Boolean);
    const operation = this.tail.then(() => this.#run({ ...job, signal: AbortSignal.any(signals) }));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async #run({ requestSeq, acceptedMonoMs, buffer, writable, beforeFirstWrite = async () => {}, signal }) {
    if (!Buffer.isBuffer(buffer)) throw new TypeError('scheduler buffer must be a Buffer');
    let offset = 0;
    let first = true;
    let firstByteAtRunMs = null;
    const eligible = acceptedMonoMs + this.responseStartDelayMs;
    if (this.clock.nowMonoMs() < eligible) await this.clock.sleep(eligible - this.clock.nowMonoMs(), { signal });
    while (offset < buffer.length) {
      if (signal?.aborted || writable.destroyed) throw abortError();
      let allowance = this.ledger.take(Math.min(this.maxChunkBytes, buffer.length - offset), this.clock.nowMonoMs());
      if (allowance === 0) {
        await this.clock.sleep(this.ledger.waitMsForOneByte(this.clock.nowMonoMs()), { signal });
        continue;
      }
      const phase = this.ledger.phaseAt(this.clock.nowMonoMs());
      if (first) {
        await beforeFirstWrite(phase);
        firstByteAtRunMs = this.clock.nowMonoMs() - this.startMonoMs;
        first = false;
      }
      const chunk = buffer.subarray(offset, offset + allowance);
      const accepted = writable.write(chunk);
      offset += allowance;
      this.cumulativeBytes += allowance;
      await this.logger({ kind: 'write', requestSeq, atRunMs: this.clock.nowMonoMs() - this.startMonoMs, phaseId: phase.id, targetKbps: phase.downlinkKbps, bytes: allowance, cumulativeRunBytes: this.cumulativeBytes, writeAccepted: accepted });
      if (!accepted) {
        await this.logger({ kind: 'backpressure-start', requestSeq, atRunMs: this.clock.nowMonoMs() - this.startMonoMs, phaseId: phase.id, targetKbps: phase.downlinkKbps, bytes: 0, cumulativeRunBytes: this.cumulativeBytes, writeAccepted: false });
        await drainOrClose(writable, signal);
        await this.logger({ kind: 'backpressure-end', requestSeq, atRunMs: this.clock.nowMonoMs() - this.startMonoMs, phaseId: phase.id, targetKbps: phase.downlinkKbps, bytes: 0, cumulativeRunBytes: this.cumulativeBytes, writeAccepted: true });
      }
    }
    return { bytesWritten: offset, firstByteAtRunMs, lastByteAtRunMs: this.clock.nowMonoMs() - this.startMonoMs };
  }

  async idle() { await this.tail; }
  close({ abort = false } = {}) { this.closed = true; if (abort) this.abortController.abort(); }
}

export const systemClock = {
  nowMonoMs: () => performance.now(),
  sleep: (ms, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const timer = setTimeout(resolve, Math.max(0, ms));
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortError()); }, { once: true });
  }),
};
