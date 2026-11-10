import test from 'node:test';
import assert from 'node:assert/strict';
import { StallTracker } from '../src/stall-tracker.js';

const playingContext = { intended: true, paused: false, seeking: false, ended: false, mediaTimeSec: 4 };

test('startup waiting is excluded and startup delay is measured separately', () => {
  const tracker = new StallTracker(); tracker.onPlayRequested(0);
  assert.equal(tracker.onWaiting(20, playingContext), null);
  assert.equal(tracker.onPlaying(100).startupDelayMs, 100);
  assert.equal(tracker.summary().rebufferCount, 0);
});

test('short waits and duplicate waits do not become duplicate stalls', () => {
  const tracker = new StallTracker(); tracker.onPlaying(0);
  tracker.onWaiting(100, playingContext); assert.equal(tracker.onWaiting(110, playingContext), null);
  assert.equal(tracker.onPlaying(300).stall, null);
  tracker.onWaiting(400, playingContext); const result = tracker.onPlaying(700).stall;
  assert.deepEqual({ duration: result.durationMs, censored: result.censored }, { duration: 300, censored: false });
  assert.equal(tracker.summary().rebufferCount, 1);
});

test('pause/seek cancels an episode and terminal closes a long episode as censored', () => {
  const tracker = new StallTracker(); tracker.onPlaying(0); tracker.onWaiting(100, playingContext);
  assert.equal(tracker.onPauseOrSeek(400, 'seek'), null);
  assert.equal(tracker.summary().rebufferCount, 0);
  tracker.onWaiting(500, playingContext); const terminal = tracker.onTerminal(900, 'fatal_error');
  assert.deepEqual({ duration: terminal.durationMs, censored: terminal.censored, reason: terminal.closeReason }, { duration: 400, censored: true, reason: 'fatal_error' });
});
