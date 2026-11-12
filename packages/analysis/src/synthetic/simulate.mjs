// Synthetic experiment generator: a toy player + network simulation that
// writes a complete fake 18-run dataset in exactly the raw format Galib's
// server produces (run.json, events.ndjson, server-requests.ndjson), using
// the real frozen scenarios and the measured media ladder.
//
//   node packages/analysis/src/synthetic/simulate.mjs --out results/synthetic/raw
//
// This is NOT the real experiment and its numbers mean nothing about real
// hls.js. It exists only so the validator → reducer → summary → chart
// pipeline can be exercised end to end before Susmoy's player exists.
// Every run.json it writes has clientLabel "synthetic-sim".

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { runOrder } from '../../../runner/src/order.mjs';
import { loadContext } from '../context.mjs';
import { RAW_ARTIFACTS, repoRoot, sha256File } from '../io.mjs';
import { EPOCH_BASE_MS, EventLog, clientReadyData, fakeRunId, rng, toNdjson, urlPath } from './eventlog.mjs';

const SEGMENT_SEC = 2;
// Smaller than hls.js's 30 s default on purpose, so the fake data contains
// stalls for the pipeline to measure.
const MAX_BUFFER_SEC = 10;
const DT_MS = 10;
const SAMPLE_MS = 250;
const RTT_MS = 10;
const RESPONSE_START_DELAY_MS = 20;

// --- toy ABR policies ------------------------------------------------------

// Rough stand-in for stock hls.js: time-weighted fast/slow EWMA, take the
// minimum, then pick the highest level under 0.95× (down) or 0.9× (up).
// Deliberately a bit greedy so the fake data shows a trade-off.
function makeDefaultPolicy(ladder) {
  let fast = null;
  let slow = null;
  let level = 0;
  const ewma = (prev, x, sec, halfLife) => {
    const a = Math.exp(Math.log(0.5) * sec / halfLife);
    return prev === null ? x : a * prev + (1 - a) * x;
  };
  return {
    id: 'default-hlsjs',
    estimate: () => (fast === null ? 500000 : Math.min(fast, slow)),
    onFragment({ bps, sec }) {
      fast = ewma(fast, bps, sec, 3);
      slow = ewma(slow, bps, sec, 9);
    },
    onStall() {},
    choose() {
      const est = this.estimate();
      let best = 0;
      for (const l of ladder) {
        const factor = l.level > level ? 0.9 : 0.95;
        if (l.bitrateBps <= factor * est) best = l.level;
      }
      level = best;
      return { level, decision: null };
    },
  };
}

// conservative-throughput-v1 as specified in PROJECT_DESIGN.md §6.3.
function makeConservativePolicy(ladder) {
  let fast = null;
  let slow = null;
  let samples = 0;
  let level = 0;
  let upEvidence = 0;
  let stallFlag = false;
  return {
    id: 'conservative-throughput-v1',
    estimate: () => (fast === null ? null : Math.min(fast, slow)),
    onFragment({ bps }) {
      fast = fast === null ? bps : 0.5 * bps + 0.5 * fast;
      slow = slow === null ? bps : 0.2 * bps + 0.8 * slow;
      samples += 1;
      upEvidence += 1;
    },
    onStall() {
      stallFlag = true;
    },
    choose({ bufferSec }) {
      const from = level;
      const est = this.estimate();
      const lowBuffer = bufferSec < 4;
      const safetyFactor = lowBuffer ? 0.7 : 0.85;
      const safeBudget = est === null ? null : safetyFactor * est;
      let reason = 'hold';
      if (stallFlag) {
        level = 0;
        upEvidence = 0;
        stallFlag = false;
        reason = 'stall_reset';
      } else if (est === null) {
        level = 0;
        reason = 'startup_lowest';
      } else if (ladder[level].bitrateBps > safeBudget) {
        while (level > 0 && ladder[level].bitrateBps > safeBudget) level -= 1;
        upEvidence = 0;
        reason = lowBuffer ? 'down_low_buffer' : 'down_over_budget';
      } else if (level < ladder.length - 1 && upEvidence >= 3 && bufferSec >= Math.max(8, 2 * SEGMENT_SEC)
        && ladder[level + 1].bitrateBps <= 0.7 * est) {
        level += 1;
        upEvidence = 0;
        reason = 'up_one_rung';
      }
      return {
        level,
        decision: {
          policyId: 'conservative-throughput-v1',
          fromLevel: from,
          toLevel: level,
          reason,
          validSamples: samples,
          fastBps: fast,
          slowBps: slow,
          estimateBps: est,
          safetyFactor,
          safeBudgetBps: safeBudget,
          forwardBufferSec: Math.round(bufferSec * 1000) / 1000,
          upEvidence,
        },
      };
    },
  };
}


// --- one simulated run -----------------------------------------------------

const segmentPath = (level, sn) => `v${level}/seg_${String(sn).padStart(5, '0')}.ts`;

export function simulateRun({ runId, policyId, scenario, ladder, durationSec, seed, faults = {}, maxWallMs = 240000 }) {
  const r = rng(seed);
  const segments = Math.ceil(durationSec / SEGMENT_SEC);
  const segDur = (sn) => (sn < segments - 1 ? SEGMENT_SEC : Math.round((durationSec - SEGMENT_SEC * (segments - 1)) * 1e6) / 1e6);
  const policy = policyId === 'default-hlsjs' ? makeDefaultPolicy(ladder) : makeConservativePolicy(ladder);
  const log = new EventLog(runId);
  const requests = [];
  // Player clock when it sends /start; the server fixes scenario time 0 a
  // couple of ms later, on receipt.
  const startSend = 1200 + Math.floor(r() * 300);
  const zero = startSend + 2;
  const runMs = (t) => Math.round((t - zero) * 1000) / 1000;
  const phaseAt = (s) => {
    let k = 0;
    while (k + 1 < scenario.phases.length && s >= scenario.phases[k + 1].startMs) k += 1;
    return k;
  };
  const phaseJitter = scenario.phases.map(() => 1 + (r() - 0.5) * 0.06);
  const capacityBps = (tMs) => {
    const k = phaseAt(tMs - zero);
    return scenario.phases[k].downlinkKbps * 1000 * phaseJitter[k] * (1 + (r() - 0.5) * 0.06);
  };

  log.emit(200, 'client.ready', clientReadyData());
  log.emit(startSend - 150, 'hls.manifest_parsed', { levels: ladder.map(({ id, ...l }) => l), firstLevel: 0 });
  const tPlay = zero + 30;
  log.emit(tPlay, 'media.play_requested', { muted: true, autoplay: true });
  log.emit(tPlay + 5, 'media.waiting', { readyState: 0, forwardBufferSec: 0 }, 0);

  const buffered = []; // { sn, level, startSec }
  let bufferEnd = 0;
  let dl = null;
  let nextSn = 0;
  let chosenLevel = null;
  let started = false;
  let stalled = false;
  let ended = false;
  let currentTime = 0;
  let shownIdx = 0;
  let shownLevel = null;
  let nextSampleT = tPlay;
  const levelData = (l) => { const { id, ...rest } = ladder[l]; return rest; };

  let t = tPlay;
  for (; t < zero + maxWallMs && !ended; t += DT_MS) {
    // Downloads: one fragment at a time, bounded by the buffer target.
    if (!dl && nextSn < segments && bufferEnd - currentTime < MAX_BUFFER_SEC) {
      const { level, decision } = policy.choose({ bufferSec: bufferEnd - currentTime });
      if (decision) log.emit(t, 'abr.decision', decision);
      if (level !== chosenLevel) {
        log.emit(t, 'hls.level_switching', levelData(level), currentTime);
        chosenLevel = level;
      }
      const bytes = Math.round((ladder[level].averageBitrateBps * segDur(nextSn) / 8) * (0.9 + r() * 0.2));
      dl = { sn: nextSn, level, bytes, remaining: bytes, startT: t, firstByteT: null, waitMs: RESPONSE_START_DELAY_MS + RTT_MS };
      log.emit(t, 'hls.frag_loading', { level, sn: nextSn, startSec: nextSn * SEGMENT_SEC, durationSec: segDur(nextSn), urlPath: urlPath(runId, level, String(nextSn).padStart(5, '0')) });
    }
    if (dl) {
      if (dl.waitMs > 0) dl.waitMs -= DT_MS;
      else {
        if (dl.firstByteT === null) dl.firstByteT = t;
        dl.remaining -= capacityBps(t) * DT_MS / 1000 / 8;
      }
      if (dl.remaining <= 0) {
        const sec = (t - dl.startT) / 1000;
        const accepted = runMs(dl.startT + RTT_MS / 2);
        requests.push({
          schemaVersion: '1.0.0', runId, requestSeq: requests.length, method: 'GET', path: segmentPath(dl.level, dl.sn), range: null, status: 200,
          phaseAtAccept: scenario.phases[phaseAt(accepted)].id, acceptedAtRunMs: accepted, eligibleAtRunMs: accepted + RESPONSE_START_DELAY_MS,
          firstByteAtRunMs: runMs(dl.firstByteT), lastByteAtRunMs: runMs(t), representationBytes: dl.bytes, bodyBytesWritten: dl.bytes,
          aborted: false, abortCode: null, backpressureWaitMs: 0,
        });
        log.emit(t, 'hls.frag_loaded', { level: dl.level, sn: dl.sn, bytes: dl.bytes, loadStartMs: dl.startT, firstByteMs: dl.firstByteT, loadEndMs: t });
        policy.onFragment({ bps: 8 * dl.bytes / sec, sec });
        log.emit(t + 3, 'hls.frag_buffered', { level: dl.level, sn: dl.sn, bytes: dl.bytes, bandwidthEstimateBps: policy.estimate() });
        buffered.push({ sn: dl.sn, level: dl.level, startSec: dl.sn * SEGMENT_SEC });
        bufferEnd += segDur(dl.sn);
        nextSn += 1;
        dl = null;
      }
    }

    // Playback.
    if (!started && bufferEnd >= SEGMENT_SEC) {
      started = true;
      log.emit(t, 'media.playing', { readyState: 4, forwardBufferSec: bufferEnd }, 0);
    } else if (started && stalled && (bufferEnd - currentTime >= SEGMENT_SEC || nextSn >= segments)) {
      stalled = false;
      log.emit(t, 'media.playing', { readyState: 4, forwardBufferSec: bufferEnd - currentTime }, currentTime);
    }
    if (started && !stalled) {
      currentTime = Math.min(currentTime + DT_MS / 1000, bufferEnd);
      if (currentTime >= durationSec - 1e-9) {
        ended = true;
        log.emit(t, 'media.ended', { durationSec }, durationSec);
        log.emit(t + 1, 'media.pause', { reason: 'ended' }, durationSec);
      } else if (currentTime >= bufferEnd - 1e-9) {
        stalled = true;
        policy.onStall();
        log.emit(t, 'media.waiting', { readyState: 2, forwardBufferSec: 0 }, currentTime);
      }
    }
    while (started && shownIdx < buffered.length && currentTime >= buffered[shownIdx].startSec) {
      const f = buffered[shownIdx];
      const ld = ladder[f.level];
      log.emit(t, 'hls.frag_changed', { level: f.level, sn: f.sn, startSec: f.startSec, durationSec: segDur(f.sn), bitrateBps: ld.bitrateBps, width: ld.width, height: ld.height }, currentTime);
      if (f.level !== shownLevel) {
        log.emit(t, 'hls.level_switched', levelData(f.level), currentTime);
        shownLevel = f.level;
      }
      shownIdx += 1;
    }

    // 4 Hz media samples.
    if (t >= nextSampleT && !ended) {
      log.emit(t, 'media.sample', {
        currentTimeSec: Math.round(currentTime * 1000) / 1000,
        readyState: started && !stalled ? 4 : 2,
        forwardBufferSec: Math.round(Math.max(0, bufferEnd - currentTime) * 1000) / 1000,
        paused: false,
        seeking: false,
        playbackRate: 1,
      }, currentTime);
      nextSampleT += SAMPLE_MS;
    }

    if (faults.hiddenAtMs && t - zero === faults.hiddenAtMs) {
      log.emit(t, 'client.visibility_changed', { state: 'hidden' });
      log.emit(t + 2000, 'client.visibility_changed', { state: 'visible' });
    }
  }

  const reason = ended ? 'ended' : 'timeout';
  log.emit(t + 100, 'client.finished', { reason, droppedVideoFrames: Math.floor(r() * 20), totalVideoFrames: Math.round(currentTime * 30) });
  return { events: log.finalize(), serverRequests: requests, startSend, reason };
}

// --- whole dataset ---------------------------------------------------------

const fakeHex = (seed, n) => { const r = rng(seed); return Array.from({ length: n }, () => Math.floor(r() * 16).toString(16)).join(''); };
const fakeUuid = (seed) => { const h = fakeHex(seed, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`; };

export function generateDataset({ outDir, injectInvalid = true }) {
  const ctx = loadContext();
  const traces = [...ctx.scenarios.values()].filter((s) => ctx.experiment.scenarioFiles.includes(s.path));
  const order = runOrder(ctx.experiment, traces.map((s) => s.id));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  let attempt = 0;
  const writeRun = (cell, seed, faults) => {
    attempt += 1;
    const entry = ctx.scenarios.get(cell.trace);
    const runId = fakeRunId(seed);
    const sim = simulateRun({ runId, policyId: cell.policy, scenario: entry.scenario, ladder: ctx.ladder, durationSec: ctx.durationSec, seed, faults, maxWallMs: ctx.experiment.stopPolicy.maxWallDurationMs });
    const dir = path.join(outDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'events.ndjson'), toNdjson(sim.events));
    fs.writeFileSync(path.join(dir, 'server-requests.ndjson'), toNdjson(sim.serverRequests));
    fs.writeFileSync(path.join(dir, 'scheduler-writes.ndjson'), '');
    const artifacts = Object.fromEntries(RAW_ARTIFACTS.map((name) => [name, sha256File(path.join(dir, name))]));
    const createdMs = EPOCH_BASE_MS + attempt * 600000;
    const iso = (ms) => new Date(ms).toISOString();
    const startedEpoch = createdMs + 1000;
    // Same shape and field order as Galib's RunStore writes.
    const run = {
      schemaVersion: '1.0.0', runId, requestId: fakeUuid(seed), status: 'COMPLETED', experimentId: ctx.experiment.id,
      experimentSha256: ctx.experimentSha256, scenarioId: cell.trace, scenarioSha256: entry.computedSha256, packageSha256: ctx.packageSha256,
      policyId: cell.policy, repetition: cell.repetition, orderSeed: ctx.experiment.execution.orderSeed, clientLabel: 'synthetic-sim',
      gitCommit: fakeHex(seed, 40), gitDirty: false, createdAt: iso(createdMs), startedAt: iso(startedEpoch), finishedAt: iso(startedEpoch + 200000),
      finishReason: sim.reason, failureCode: null, warnings: [], artifacts,
      startRequest: { clientSendEpochMs: startedEpoch - 2, clientSendMonoMs: sim.startSend },
      serverRunStartEpochMs: startedEpoch, serverRunStartMonoMs: 50000 + attempt,
      createFingerprint: crypto.createHash('sha256').update(`create${seed}`).digest('hex'),
      startFingerprint: crypto.createHash('sha256').update(`start${seed}`).digest('hex'),
      finishFingerprint: crypto.createHash('sha256').update(`finish${seed}`).digest('hex'),
    };
    fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    written.push(runId);
  };

  for (const cell of order) {
    // Practice the rerun rule once: the first volatile/default attempt has its
    // tab hidden mid-run (harness-invalid), then a clean rerun of the same cell.
    if (injectInvalid && cell.trace === 'volatile-v1' && cell.policy === 'default-hlsjs' && cell.repetition === 1) {
      writeRun(cell, 9000 + cell.orderIndex, { hiddenAtMs: 30000 });
    }
    writeRun(cell, 1000 + cell.orderIndex, {});
  }
  fs.writeFileSync(path.join(outDir, '..', 'run-order.json'), `${JSON.stringify({ orderSeed: ctx.experiment.execution.orderSeed, order }, null, 2)}\n`);
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'results/synthetic/raw' },
      'no-invalid': { type: 'boolean', default: false },
    },
  });
  const ids = generateDataset({ outDir: path.resolve(repoRoot, values.out), injectInvalid: !values['no-invalid'] });
  console.log(`Wrote ${ids.length} synthetic run(s) to ${values.out}`);
}
