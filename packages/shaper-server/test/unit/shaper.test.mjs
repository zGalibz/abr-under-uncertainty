import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { TokenLedger } from '../../src/shaping/token-ledger.mjs';
import { FifoScheduler } from '../../src/shaping/fifo-scheduler.mjs';
import { compileSchedule } from '../../src/domain/scenario.mjs';

class FakeClock {
  constructor() { this.value = 0; }
  nowMonoMs() { return this.value; }
  async sleep(ms) { this.value += ms; }
}

class FakeWritable extends EventEmitter {
  constructor() { super(); this.chunks = []; }
  write(chunk) { this.chunks.push(Buffer.from(chunk)); return true; }
}

const scenario = { responseStartDelayMs: 0, scheduler: { maxBurstBytes: 100, maxChunkBytes: 100 }, phases: [{ id: 'only', startMs: 0, downlinkKbps: 8 }] };

test('token ledger starts empty, integrates elapsed capacity and caps bursts', () => {
  const schedule = compileSchedule(scenario);
  const ledger = new TokenLedger({ schedule, maxBurstBytes: 100, startMonoMs: 0 });
  assert.equal(ledger.take(100, 0), 0);
  assert.equal(ledger.take(100, 50), 50);
  assert.equal(ledger.take(100, 1000), 100);
});

test('concurrent transfers share one FIFO run budget', async () => {
  const clock = new FakeClock();
  const schedule = compileSchedule(scenario);
  const scheduler = new FifoScheduler({ clock, schedule, startMonoMs: 0, maxBurstBytes: 100, maxChunkBytes: 100, responseStartDelayMs: 0 });
  const first = new FakeWritable();
  const second = new FakeWritable();
  const [a, b] = await Promise.all([
    scheduler.enqueue({ requestSeq: 1, acceptedMonoMs: 0, buffer: Buffer.alloc(1000, 1), writable: first }),
    scheduler.enqueue({ requestSeq: 2, acceptedMonoMs: 0, buffer: Buffer.alloc(1000, 2), writable: second }),
  ]);
  assert.equal(a.bytesWritten, 1000);
  assert.equal(b.bytesWritten, 1000);
  assert.equal(Buffer.concat(first.chunks).length, 1000);
  assert.equal(Buffer.concat(second.chunks).length, 1000);
  assert.ok(clock.value >= 1900 && clock.value <= 2100, `elapsed ${clock.value}`);
  assert.equal(scheduler.cumulativeBytes, 2000);
});

// A response whose client is gone never emits 'drain'. The scheduler is one
// FIFO per run, so waiting on such a response would starve every later
// request of the run until the player times out.
class ClosedWritable extends EventEmitter {
  constructor() { super(); this.destroyed = true; this.writes = 0; }
  write() { this.writes += 1; return false; }
}

class ClosesDuringBackpressureWritable extends EventEmitter {
  constructor() { super(); this.destroyed = false; }
  write() { setImmediate(() => { this.destroyed = true; this.emit('close'); }); return false; }
}

test('a response the client already closed is skipped instead of blocking the run queue', { timeout: 2000 }, async () => {
  const clock = new FakeClock();
  const scheduler = new FifoScheduler({ clock, schedule: compileSchedule(scenario), startMonoMs: 0, maxBurstBytes: 100, maxChunkBytes: 100, responseStartDelayMs: 0 });
  const gone = new ClosedWritable();
  const next = new FakeWritable();
  const cancelled = scheduler.enqueue({ requestSeq: 1, acceptedMonoMs: 0, buffer: Buffer.alloc(300, 1), writable: gone });
  const following = scheduler.enqueue({ requestSeq: 2, acceptedMonoMs: 0, buffer: Buffer.alloc(300, 2), writable: next });
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await following).bytesWritten, 300);
  assert.equal(gone.writes, 0);
});

test('a response that closes while waiting for drain releases the run queue', { timeout: 2000 }, async () => {
  const clock = new FakeClock();
  const scheduler = new FifoScheduler({ clock, schedule: compileSchedule(scenario), startMonoMs: 0, maxBurstBytes: 100, maxChunkBytes: 100, responseStartDelayMs: 0 });
  const stalled = new ClosesDuringBackpressureWritable();
  const next = new FakeWritable();
  const cancelled = scheduler.enqueue({ requestSeq: 1, acceptedMonoMs: 0, buffer: Buffer.alloc(300, 1), writable: stalled });
  const following = scheduler.enqueue({ requestSeq: 2, acceptedMonoMs: 0, buffer: Buffer.alloc(300, 2), writable: next });
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await following).bytesWritten, 300);
});
