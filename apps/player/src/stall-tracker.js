/** Pure playback-stall state machine. Times are caller-supplied monotonic ms. */
export class StallTracker {
  constructor({ minimumDurationMs = 250 } = {}) {
    this.minimumDurationMs = minimumDurationMs;
    this.hasPlayed = false;
    this.playRequestedAtMs = null;
    this.firstPlayingAtMs = null;
    this.open = null;
    this.stalls = [];
  }

  onPlayRequested(atMs) {
    this.playRequestedAtMs ??= atMs;
  }

  onWaiting(atMs, context) {
    if (this.open || !this.hasPlayed || !context.intended || context.paused || context.seeking || context.ended) return null;
    this.open = { startMs: atMs, mediaTimeSec: context.mediaTimeSec };
    return { kind: 'opened', ...this.open };
  }

  onPlaying(atMs) {
    const startupDelayMs = this.firstPlayingAtMs === null && this.playRequestedAtMs !== null ? atMs - this.playRequestedAtMs : null;
    this.firstPlayingAtMs ??= atMs;
    this.hasPlayed = true;
    return { startupDelayMs, stall: this.close(atMs, false, 'playing') };
  }

  onPauseOrSeek(atMs, reason) {
    // A user pause or seek changes playback intent, so this is excluded rather
    // than counted as a network rebuffer episode.
    this.open = null;
    return null;
  }

  onTerminal(atMs, reason) {
    return this.close(atMs, true, reason);
  }

  close(atMs, censored, closeReason) {
    if (!this.open) return null;
    const started = this.open;
    this.open = null;
    const durationMs = Math.max(0, atMs - started.startMs);
    if (durationMs < this.minimumDurationMs) return null;
    const stall = { ...started, endMs: atMs, durationMs, censored, closeReason };
    this.stalls.push(stall);
    return stall;
  }

  summary() {
    return {
      startupDelayMs: this.firstPlayingAtMs === null || this.playRequestedAtMs === null ? null : this.firstPlayingAtMs - this.playRequestedAtMs,
      rebufferCount: this.stalls.filter((stall) => !stall.censored).length,
      rebufferDurationMs: this.stalls.filter((stall) => !stall.censored).reduce((sum, stall) => sum + stall.durationMs, 0),
      censoredStalls: this.stalls.filter((stall) => stall.censored),
    };
  }
}
