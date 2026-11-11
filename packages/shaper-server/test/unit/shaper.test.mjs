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
