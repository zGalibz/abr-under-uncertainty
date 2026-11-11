export class TokenLedger {
  constructor({ schedule, maxBurstBytes, startMonoMs }) {
    this.schedule = schedule;
    this.maxBurstBytes = maxBurstBytes;
    this.startMonoMs = startMonoMs;
    this.lastRunMs = 0;
    this.tokens = 0;
  }

  update(nowMonoMs) {
    const runMs = nowMonoMs - this.startMonoMs;
    if (runMs < this.lastRunMs) throw new RangeError('shaper clock moved backwards');
    this.tokens = Math.min(this.maxBurstBytes, this.tokens + this.schedule.integratedBytes(this.lastRunMs, runMs));
    this.lastRunMs = runMs;
    return this.tokens;
  }

  take(maxBytes, nowMonoMs) {
    this.update(nowMonoMs);
    const amount = Math.max(0, Math.min(Math.floor(this.tokens), maxBytes));
    this.tokens -= amount;
    return amount;
  }

  waitMsForOneByte(nowMonoMs) {
    this.update(nowMonoMs);
    if (this.tokens >= 1) return 0;
    return this.schedule.msUntilBytes(this.lastRunMs, 1 - this.tokens);
  }

  phaseAt(nowMonoMs) {
    return this.schedule.phaseAt(nowMonoMs - this.startMonoMs);
  }
}
