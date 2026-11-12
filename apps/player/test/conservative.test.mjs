import test from 'node:test';
import assert from 'node:assert/strict';
import { ConservativeThroughputPolicy, requestGoodputBps, validateLadder } from '../src/policy/conservative.js';

const ladder = [
  { index: 0, bitrateBps: 596000, width: 640, height: 360, codecs: 'avc1.64001e,mp4a.40.2' },
  { index: 1, bitrateBps: 996000, width: 854, height: 480, codecs: 'avc1.64001e,mp4a.40.2' },
  { index: 2, bitrateBps: 1896000, width: 1280, height: 720, codecs: 'avc1.64001e,mp4a.40.2' },
  { index: 3, bitrateBps: 3296000, width: 1920, height: 1080, codecs: 'avc1.64001e,mp4a.40.2' },
];

const snapshot = (buffer = 10) => ({ requestedLevel: 0, effectiveLevel: 0, forwardBufferSec: buffer });
const fragment = (bps, retry = 0, extra = {}) => ({ bytes: bps / 8, loadStartMs: 0, loadEndMs: 1000, durationSec: 2, retry, type: 'main', ...extra });

test('request goodput includes the complete request duration and rejects invalid samples', () => {
  assert.equal(requestGoodputBps({ bytes: 1_000_000, loadStartMs: 0, loadEndMs: 2000 }), 4_000_000);
  for (const invalid of [{ bytes: 0, loadStartMs: 0, loadEndMs: 1000 }, { bytes: 100, loadStartMs: 0, loadEndMs: 49 }, { bytes: 1, loadStartMs: 0, loadEndMs: Infinity }, { bytes: 1, loadStartMs: 0, loadEndMs: 100, aborted: true }]) {
    assert.equal(requestGoodputBps(invalid), null);
  }
  assert.equal(requestGoodputBps({ type: 'audio', bytes: 1000, loadStartMs: 0, loadEndMs: 100 }), null);
});

test('ladder requires increasing bitrate and dimensions', () => {
  assert.equal(validateLadder(ladder).length, 4);
  assert.throws(() => validateLadder([{ ...ladder[0] }, { ...ladder[1], bitrateBps: 596000 }]), /invalid_ladder/);
});

test('accepts actual H264 rendition codec profile-level identifiers', () => {
  const actualLadder = [
    { ...ladder[0], codecs: 'avc1.64001e,mp4a.40.2' },
    { ...ladder[1], codecs: 'avc1.64001f,mp4a.40.2' },
    { ...ladder[2], codecs: 'avc1.64001f,mp4a.40.2' },
    { ...ladder[3], codecs: 'avc1.640028,mp4a.40.2' },
  ];

  assert.equal(validateLadder(actualLadder).length, 4);

  const policy = new ConservativeThroughputPolicy();
  const decision = policy.onManifest(actualLadder);

  assert.equal(decision.reason, 'startup_lowest');
  assert.equal(decision.toLevel, 0);
});

test('policy starts at lowest, upgrades only after three clean high-buffer fragments, and moves one rung', () => {
  const policy = new ConservativeThroughputPolicy();
  const start = policy.onManifest(ladder);
  assert.equal(start.toLevel, 0);
  assert.equal(start.reason, 'startup_lowest');
  assert.equal(policy.onFragment(fragment(8_000_000), snapshot()).reason, 'hold_upgrade_evidence');
  assert.equal(policy.onFragment(fragment(8_000_000), snapshot()).reason, 'hold_upgrade_evidence');
  const upgraded = policy.onFragment(fragment(8_000_000), snapshot());
  assert.deepEqual({ to: upgraded.toLevel, reason: upgraded.reason }, { to: 1, reason: 'up_confirmed_one_rung' });
});

test('throughput loss makes the fast estimator control and can downswitch multiple rungs', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder); policy.desiredLevel = 3;
  policy.fastBps = 1_200_000; policy.slowBps = 1_200_000;
  const decision = policy.evaluate({ requestedLevel: 3, effectiveLevel: 3, forwardBufferSec: 10 }, { retry: false, relevantError: false, validSample: false });
  assert.deepEqual({ to: decision.toLevel, reason: decision.reason }, { to: 1, reason: 'down_throughput' });
  policy.onFragment(fragment(500_000), snapshot());
  assert.ok(policy.snapshot().fastBps < policy.snapshot().slowBps);
  for (let index = 0; index < 8; index += 1) policy.onFragment(fragment(8_000_000), snapshot());
  assert.ok(policy.snapshot().slowBps > 500_000, 'the slow estimate recovers only after sustained high samples');
});

test('downswitches use bitrate ladder position when rendition indices are scrambled', () => {
  const scrambled = [
    { ...ladder[0], index: 9 },
    { ...ladder[1], index: 2 },
    { ...ladder[2], index: 7 },
    { ...ladder[3], index: 1 },
  ];
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(scrambled); policy.desiredLevel = 2;
  policy.fastBps = 700_000; policy.slowBps = 700_000; policy.upEvidence = 2;
  const decision = policy.evaluate({ requestedLevel: 2, effectiveLevel: 2, forwardBufferSec: 10 }, { retry: false, relevantError: false, validSample: false });
  assert.deepEqual({ to: decision.toLevel, reason: decision.reason, upEvidence: decision.upEvidence }, { to: 9, reason: 'down_throughput', upEvidence: 0 });
});

test('pending upgrades remain the control target until they take effect', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder); policy.desiredLevel = 1;
  policy.fastBps = 8_000_000; policy.slowBps = 8_000_000;
  const decision = policy.evaluate({ requestedLevel: 0, effectiveLevel: 0, forwardBufferSec: 10 }, { retry: false, relevantError: false, validSample: false });
  assert.deepEqual({ from: decision.fromLevel, to: decision.toLevel, reason: decision.reason }, { from: 1, to: 1, reason: 'hold_upgrade_bandwidth' });
});

test('high-buffer gate holds a qualifying upgrade until enough media is buffered', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder);
  policy.onFragment(fragment(8_000_000), snapshot(3)); policy.onFragment(fragment(8_000_000), snapshot(3));
  const held = policy.onFragment(fragment(8_000_000), snapshot(3));
  assert.deepEqual({ to: held.toLevel, reason: held.reason }, { to: 0, reason: 'hold_upgrade_buffer' });
});

test('identical input replay produces identical conservative decisions', () => {
  const replay = () => { const policy = new ConservativeThroughputPolicy(); const decisions = [policy.onManifest(ladder)];
    for (const rate of [8_000_000, 8_000_000, 8_000_000, 500_000, 8_000_000]) decisions.push(policy.onFragment(fragment(rate), snapshot()));
    return decisions; };
  assert.deepEqual(replay(), replay());
});

test('low buffer uses 0.70 margin and retry resets upgrade evidence', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder); policy.desiredLevel = 1;
  policy.fastBps = 1_200_000; policy.slowBps = 1_200_000; policy.upEvidence = 2;
  const decision = policy.evaluate({ requestedLevel: 1, effectiveLevel: 1, forwardBufferSec: 1 }, { retry: false, relevantError: false, validSample: false });
  assert.deepEqual({ to: decision.toLevel, reason: decision.reason, safety: decision.safetyFactor }, { to: 0, reason: 'down_low_buffer', safety: 0.7 });
  policy.onFragment(fragment(8_000_000, 1), snapshot());
  assert.equal(policy.snapshot().upEvidence, 0);
});

test('a qualified stall forces the lowest rung and blocks immediate recovery', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder); policy.desiredLevel = 2;
  policy.fastBps = 8_000_000; policy.slowBps = 8_000_000;
  const emergency = policy.onRisk('waiting', { requestedLevel: 2, effectiveLevel: 2, forwardBufferSec: 0 });
  assert.deepEqual({ to: emergency.toLevel, reason: emergency.reason }, { to: 0, reason: 'down_stall_lowest' });
  const hold = policy.onFragment(fragment(8_000_000), snapshot());
  assert.equal(hold.reason, 'hold_recovery');
});

test('only clean, valid main-media fragments count between upgrades', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder);
  policy.fragmentsSinceUpgrade = 0;
  policy.onRisk('frag_error', snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 0, 'risk events do not advance the upgrade gate');
  policy.onFragment(fragment(8_000_000, 1), snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 0, 'retried fragments do not advance the upgrade gate');
  policy.onFragment(fragment(8_000_000, 0, { relevantError: true }), snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 0, 'error fragments do not advance the upgrade gate');
  policy.onFragment(fragment(8_000_000, 0, { bytes: 0 }), snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 0, 'invalid samples do not advance the upgrade gate');
  policy.onFragment(fragment(8_000_000, 0, { type: 'audio' }), snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 0, 'non-main media does not advance the upgrade gate');
  policy.onFragment(fragment(8_000_000), snapshot());
  assert.equal(policy.fragmentsSinceUpgrade, 1);
});

test('a new manifest resets adaptation and recovery state at its lowest rendition', () => {
  const policy = new ConservativeThroughputPolicy(); policy.onManifest(ladder);
  policy.fastBps = 8_000_000; policy.slowBps = 7_000_000; policy.validSamples = 5;
  policy.desiredLevel = 3; policy.upEvidence = 2; policy.cleanRecoveryRemaining = 1;
  policy.fragmentsSinceUpgrade = 0; policy.lastDurationSec = 6;
  const decision = policy.onManifest(ladder);
  assert.deepEqual({ to: decision.toLevel, reason: decision.reason }, { to: 0, reason: 'startup_lowest' });
  assert.deepEqual({
    desiredLevel: policy.desiredLevel, fastBps: policy.fastBps, slowBps: policy.slowBps,
    validSamples: policy.validSamples, upEvidence: policy.upEvidence,
    cleanRecoveryRemaining: policy.cleanRecoveryRemaining, fragmentsSinceUpgrade: policy.fragmentsSinceUpgrade,
    lastDurationSec: policy.lastDurationSec,
  }, {
    desiredLevel: 0, fastBps: null, slowBps: null, validSamples: 0, upEvidence: 0,
    cleanRecoveryRemaining: 0, fragmentsSinceUpgrade: Number.POSITIVE_INFINITY, lastDurationSec: 2,
  });
});