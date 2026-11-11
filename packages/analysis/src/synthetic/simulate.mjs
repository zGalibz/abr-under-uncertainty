// Synthetic experiment generator: a toy player + network simulation that
// writes a complete fake 18-run dataset in the real raw-evidence format.
//
//   node packages/analysis/src/synthetic/simulate.mjs --out results/synthetic/raw
//
// This is NOT the real experiment and its numbers mean nothing about real
// hls.js. It exists only so the validator → reducer → summary → chart
// pipeline can be exercised end to end before Galib's server and Susmoy's
// player exist. Every run.json it writes carries "synthetic": true.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { readJson, repoRoot } from '../io.mjs';
import { EventLog, PLACEHOLDER_LADDER, clientReadyData, fakeRunId, rng, toNdjson, urlPath } from './eventlog.mjs';

const SEGMENT_SEC = 2;
const SEGMENTS = 60; // 120 s clip
// Smaller than hls.js's 30 s default on purpose, so the fake data contains
// stalls for the pipeline to measure.
const MAX_BUFFER_SEC = 10;
const DT_MS = 10;
const SAMPLE_MS = 250;
const RTT_MS = 10;

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

export function simulateRun({ runId, policyId, scenario, seed, faults = {}, maxWallMs = 240000 }) {
  const r = rng(seed);
  const ladder = PLACEHOLDER_LADDER;
  const policy = policyId === 'default-hlsjs' ? makeDefaultPolicy(ladder) : makeConservativePolicy(ladder);
  const log = new EventLog(runId);
  const zero = 1200 + Math.floor(r() * 300); // client clock when the server's scenario clock starts
  const phaseJitter = scenario.phases.map(() => 1 + (r() - 0.5) * 0.12);
  const capacityBps = (tMs) => {
    const s = tMs - zero;
    let k = 0;
    while (k + 1 < scenario.phases.length && s >= scenario.phases[k + 1].startMs) k += 1;
    return scenario.phases[k].downlinkKbps * 1000 * phaseJitter[k] * (1 + (r() - 0.5) * 0.1);
  };

  log.emit(200, 'client.ready', clientReadyData());
  log.emit(zero - 150, 'hls.manifest_parsed', { levels: ladder, firstLevel: 0 });
  const tPlay = zero + 30;
  log.emit(tPlay, 'media.play_requested', { muted: true, autoplay: true });
  log.emit(tPlay + 5, 'media.waiting', { readyState: 0, forwardBufferSec: 0 }, 0);

  const buffered = []; // { sn, level, startSec }
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
  const bufferEnd = () => buffered.length * SEGMENT_SEC;
  const levelData = (l) => ladder[l];

  let t = tPlay;
  for (; t < zero + maxWallMs && !ended; t += DT_MS) {
    // Downloads: one fragment at a time, bounded by the 30 s buffer target.
    if (!dl && nextSn < SEGMENTS && bufferEnd() - currentTime < MAX_BUFFER_SEC) {
      const { level, decision } = policy.choose({ bufferSec: bufferEnd() - currentTime });
      if (decision) log.emit(t, 'abr.decision', decision);
      if (level !== chosenLevel) {
        log.emit(t, 'hls.level_switching', levelData(level), currentTime);
        chosenLevel = level;
      }
      const bytes = Math.round((ladder[level].averageBitrateBps * SEGMENT_SEC / 8) * (0.9 + r() * 0.2));
      dl = { sn: nextSn, level, bytes, remaining: bytes, startT: t, firstByteT: null, waitMs: 20 + RTT_MS };
      log.emit(t, 'hls.frag_loading', { level, sn: nextSn, startSec: nextSn * SEGMENT_SEC, durationSec: SEGMENT_SEC, urlPath: urlPath(runId, level, nextSn) });
    }
    if (dl) {
      if (dl.waitMs > 0) dl.waitMs -= DT_MS;
      else {
        if (dl.firstByteT === null) dl.firstByteT = t;
        dl.remaining -= capacityBps(t) * DT_MS / 1000 / 8;
      }
      if (dl.remaining <= 0) {
        const sec = (t - dl.startT) / 1000;
        log.emit(t, 'hls.frag_loaded', { level: dl.level, sn: dl.sn, bytes: dl.bytes, loadStartMs: dl.startT, firstByteMs: dl.firstByteT, loadEndMs: t });
        policy.onFragment({ bps: 8 * dl.bytes / sec, sec });
        log.emit(t + 3, 'hls.frag_buffered', { level: dl.level, sn: dl.sn, bytes: dl.bytes, bandwidthEstimateBps: policy.estimate() });
        buffered.push({ sn: dl.sn, level: dl.level, startSec: dl.sn * SEGMENT_SEC });
        nextSn += 1;
        dl = null;
      }
    }

    // Playback.
    if (!started && bufferEnd() >= SEGMENT_SEC) {
      started = true;
      log.emit(t, 'media.playing', { readyState: 4, forwardBufferSec: bufferEnd() }, 0);
    } else if (started && stalled && (bufferEnd() - currentTime >= SEGMENT_SEC || nextSn >= SEGMENTS)) {
      stalled = false;
      log.emit(t, 'media.playing', { readyState: 4, forwardBufferSec: bufferEnd() - currentTime }, currentTime);
    }
    if (started && !stalled) {
      currentTime = Math.min(currentTime + DT_MS / 1000, bufferEnd());
      if (currentTime >= SEGMENTS * SEGMENT_SEC - 1e-9) {
        ended = true;
        log.emit(t, 'media.ended', { durationSec: SEGMENTS * SEGMENT_SEC }, SEGMENTS * SEGMENT_SEC);
        log.emit(t + 1, 'media.pause', { reason: 'ended' }, SEGMENTS * SEGMENT_SEC);
      } else if (currentTime >= bufferEnd() - 1e-9) {
        stalled = true;
        policy.onStall();
        log.emit(t, 'media.waiting', { readyState: 2, forwardBufferSec: 0 }, currentTime);
      }
    }
    while (started && shownIdx < buffered.length && currentTime >= buffered[shownIdx].startSec) {
      const f = buffered[shownIdx];
      const ld = levelData(f.level);
      log.emit(t, 'hls.frag_changed', { level: f.level, sn: f.sn, startSec: f.startSec, durationSec: SEGMENT_SEC, bitrateBps: ld.bitrateBps, width: ld.width, height: ld.height }, currentTime);
      if (f.level !== shownLevel) {
        log.emit(t, 'hls.level_switched', ld, currentTime);
        shownLevel = f.level;
      }
      shownIdx += 1;
    }

    // 4 Hz media samples.
    if (t >= nextSampleT && !ended) {
      if (!(faults.sampleBlackout && t - zero >= faults.sampleBlackout[0] && t - zero < faults.sampleBlackout[1])) {
        log.emit(t, 'media.sample', {
          currentTimeSec: Math.round(currentTime * 1000) / 1000,
          readyState: started && !stalled ? 4 : 2,
          forwardBufferSec: Math.round(Math.max(0, bufferEnd() - currentTime) * 1000) / 1000,
          paused: false,
          seeking: false,
          playbackRate: 1,
        }, currentTime);
      }
      nextSampleT += SAMPLE_MS;
    }

    if (faults.hiddenAtMs && t - zero === faults.hiddenAtMs) {
      log.emit(t, 'client.visibility_changed', { state: 'hidden' });
      log.emit(t + 2000, 'client.visibility_changed', { state: 'visible' });
    }
  }

  const reason = ended ? 'ended' : 'timeout';
  log.emit(t + 100, 'client.finished', { reason, droppedVideoFrames: Math.floor(r() * 20), totalVideoFrames: Math.round(currentTime * 30) });
  return { events: log.finalize(), clientMonoAtScenarioZeroMs: zero };
}

// --- whole dataset ---------------------------------------------------------

// Fixed randomized run order from the experiment seed (Fisher–Yates).
export function runOrder(experiment, traces) {
  const cells = [];
  for (const trace of traces) {
    for (const policy of experiment.player.policies) {
      for (let rep = 1; rep <= experiment.execution.repetitionsPerCell; rep += 1) cells.push({ policy, trace, repetition: rep });
    }
  }
  const r = rng(experiment.execution.orderSeed);
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return cells.map((c, i) => ({ orderIndex: i + 1, ...c }));
}

export function generateDataset({ outDir, experimentFile, injectInvalid = true }) {
  const experiment = readJson(experimentFile);
  const scenarios = experiment.scenarioFiles.map((f) => ({ file: f, scenario: readJson(path.join(repoRoot, f)) }));
  const order = runOrder(experiment, scenarios.map((s) => s.scenario.id));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const written = [];
  const writeRun = (cell, seed, faults, extra = {}) => {
    const { file, scenario } = scenarios.find((s) => s.scenario.id === cell.trace);
    const runId = fakeRunId(seed);
    const { events, clientMonoAtScenarioZeroMs } = simulateRun({ runId, policyId: cell.policy, scenario, seed, faults, maxWallMs: experiment.stopPolicy.maxWallDurationMs });
    const dir = path.join(outDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify({
      schemaVersion: '1.0.0',
      synthetic: true,
      runId,
      experimentId: experiment.id,
      policyId: cell.policy,
      scenarioId: cell.trace,
      scenarioFile: file,
      repetition: cell.repetition,
      orderIndex: cell.orderIndex,
      clientMonoAtScenarioZeroMs,
      ...extra,
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'events.ndjson'), toNdjson(events));
    written.push(runId);
    return runId;
  };

  for (const cell of order) {
    // Practice the rerun rule once: the first volatile/default attempt has its
    // tab hidden mid-run (harness-invalid), then a clean rerun points back to it.
    if (injectInvalid && cell.trace === 'volatile-v1' && cell.policy === 'default-hlsjs' && cell.repetition === 1) {
      const badId = writeRun(cell, 9000 + cell.orderIndex, { hiddenAtMs: 30000 });
      writeRun(cell, 1000 + cell.orderIndex, {}, { rerunOf: badId });
    } else {
      writeRun(cell, 1000 + cell.orderIndex, {});
    }
  }
  fs.writeFileSync(path.join(outDir, '..', 'run-order.json'), `${JSON.stringify({ orderSeed: experiment.execution.orderSeed, order }, null, 2)}\n`);
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: 'results/synthetic/raw' },
      experiment: { type: 'string', default: 'configs/experiment.v1.json' },
      'no-invalid': { type: 'boolean', default: false },
    },
  });
  const ids = generateDataset({
    outDir: path.resolve(repoRoot, values.out),
    experimentFile: path.resolve(repoRoot, values.experiment),
    injectInvalid: !values['no-invalid'],
  });
  console.log(`Wrote ${ids.length} synthetic run(s) to ${values.out}`);
}
