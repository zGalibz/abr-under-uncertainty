// Builds the hand-checked analysis fixtures.
//
//   node tests/fixtures/analysis/build-fixtures.mjs
//
// Each case is a tiny scripted playback session (20 s clip, ten 2 s
// fragments) written as contract-shaped raw events, plus an expected.json
// whose numbers were worked out BY HAND from the script below — not by
// running the reducer. The reducer test then checks the reducer agrees.
//
// Shared clock for every case: the player sends /start and requests play at
// client 1000 ms, which is also server scenario time 0. Server request times
// (acceptedAtRunMs) are therefore client time − 1000.
//
// Files are written in exactly the shape Galib's server produces:
//   cases/<case>/<runId>/{run.json, events.ndjson, server-requests.ndjson, scheduler-writes.ndjson}
//   cases/<case>/expected.json
// and are checked against the fixture apparatus in context/ (a 20 s, four-
// level placeholder package and two test scenarios).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Canonical } from '../../../packages/shaper-server/src/domain/canonical-json.mjs';
import { loadContext } from '../../../packages/analysis/src/context.mjs';
import { RAW_ARTIFACTS, readJson, repoRoot, sha256File } from '../../../packages/analysis/src/io.mjs';
import { EPOCH_BASE_MS, EventLog, PLACEHOLDER_LADDER, clientReadyData, fakeRunId, toNdjson, urlPath } from '../../../packages/analysis/src/synthetic/eventlog.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const Z = 1000;
const SEG = 2;
const CLIP_SEC = 20;

function script({ seed, startupMs = 500, pieces, terminal = 'ended', levelForSn = () => 3, extra = [], dropSamples = null, startupDupWaitingAt = [] }) {
  const runId = fakeRunId(seed);
  const log = new EventLog(runId);
  const requests = [];
  const ld = (l) => PLACEHOLDER_LADDER[l];
  log.emit(100, 'client.ready', clientReadyData());
  log.emit(900, 'hls.manifest_parsed', { levels: PLACEHOLDER_LADDER, firstLevel: 0 });
  log.emit(Z, 'media.play_requested', { muted: true, autoplay: true });
  log.emit(Z + 5, 'media.waiting', { readyState: 0, forwardBufferSec: 0 }, 0);
  for (const at of startupDupWaitingAt) log.emit(Z + at, 'media.waiting', { readyState: 0, forwardBufferSec: 0 }, 0);

  const tFirst = Z + startupMs;
  log.emit(tFirst, 'media.playing', { readyState: 4, forwardBufferSec: 6 }, 0);

  // Lay the pieces out on the clock.
  let t = tFirst;
  let media = 0;
  const laid = pieces.map((p) => {
    const piece = { ...p, start: t, mediaStart: media };
    if (p.play) { t += p.play; media += p.play / 1000; }
    if (p.stall) t += p.stall;
    piece.end = t;
    return piece;
  });
  const tEnd = t;

  // Stalls: waiting at start, optional duplicate, playing at end (unless last).
  laid.forEach((p, i) => {
    if (!p.stall) return;
    log.emit(p.start, 'media.waiting', { readyState: 2, forwardBufferSec: 0 }, p.mediaStart);
    if (p.dupAt) log.emit(p.start + p.dupAt, 'media.waiting', { readyState: 2, forwardBufferSec: 0 }, p.mediaStart);
    if (i < laid.length - 1) log.emit(p.end, 'media.playing', { readyState: 4, forwardBufferSec: 2 }, p.mediaStart);
  });

  // Fragments: shown when the playhead crosses 2·sn; loaded 1.5 s earlier.
  for (let sn = 0; sn < CLIP_SEC / SEG; sn += 1) {
    const p = laid.find((x) => x.play && x.mediaStart <= sn * SEG && sn * SEG < x.mediaStart + x.play / 1000);
    if (!p) continue;
    const shown = p.start + (sn * SEG - p.mediaStart) * 1000;
    const level = levelForSn(sn);
    const loadAt = Math.max(Z + 10, shown - 1500);
    log.emit(loadAt, 'hls.frag_loading', { level, sn, startSec: sn * SEG, durationSec: SEG, urlPath: urlPath(runId, level, sn) });
    log.emit(loadAt + 390, 'hls.frag_loaded', { level, sn, bytes: 500000, loadStartMs: loadAt, firstByteMs: loadAt + 30, loadEndMs: loadAt + 390 });
    log.emit(loadAt + 400, 'hls.frag_buffered', { level, sn, bytes: 500000, bandwidthEstimateBps: 6000000 });
    requests.push({
      schemaVersion: '1.0.0', runId, requestSeq: requests.length, method: 'GET', path: `v${level}/seg_${String(sn).padStart(5, '0')}.ts`,
      range: null, status: 200, phaseAtAccept: null, acceptedAtRunMs: loadAt - Z, eligibleAtRunMs: loadAt - Z + 20,
      firstByteAtRunMs: loadAt - Z + 30, lastByteAtRunMs: loadAt - Z + 385, representationBytes: 500000, bodyBytesWritten: 500000,
      aborted: false, abortCode: null, backpressureWaitMs: 0,
    });
    log.emit(shown, 'hls.frag_changed', { level, sn, startSec: sn * SEG, durationSec: SEG, bitrateBps: ld(level).bitrateBps, width: ld(level).width, height: ld(level).height }, sn * SEG);
  }

  // 4 Hz samples on the grid tFirst + 250·k.
  for (let s = tFirst + 250; s < tEnd; s += 250) {
    if (dropSamples && s >= dropSamples[0] && s < dropSamples[1]) continue;
    const p = laid.find((x) => x.start <= s && s < x.end);
    const ct = p.play ? p.mediaStart + (s - p.start) / 1000 : p.mediaStart;
    log.emit(s, 'media.sample', { currentTimeSec: ct, readyState: p.play ? 4 : 2, forwardBufferSec: p.play ? (p.buffer ?? 6) : 0, paused: false, seeking: false, playbackRate: 1 }, ct);
  }

  for (const [at, type, data, mediaTimeSec] of extra) log.emit(at, type, data, mediaTimeSec);

  if (terminal === 'ended') {
    log.emit(tEnd, 'media.ended', { durationSec: CLIP_SEC }, CLIP_SEC);
    log.emit(tEnd + 1, 'media.pause', { reason: 'ended' }, CLIP_SEC);
    log.emit(tEnd + 100, 'client.finished', { reason: 'ended', droppedVideoFrames: 0, totalVideoFrames: 600 });
  } else if (terminal === 'timeout') {
    log.emit(tEnd, 'client.finished', { reason: 'timeout', droppedVideoFrames: 0, totalVideoFrames: 240 });
  } else if (terminal === 'fatal') {
    log.emit(tEnd, 'hls.error', { fatal: true, errorType: 'networkError', details: 'fragLoadError', httpStatus: 503 });
    log.emit(tEnd + 50, 'client.finished', { reason: 'fatal_error', droppedVideoFrames: 0, totalVideoFrames: 300 });
  }
  requests.sort((a, b) => a.acceptedAtRunMs - b.acceptedAtRunMs).forEach((r, i) => { r.requestSeq = i; });
  return { runId, events: log.finalize(), serverRequests: requests };
}

const STABLE = 'fixture-stable';
const DROP = 'fixture-drop';
const fullPlay = [{ play: 20000 }];
const oneStall = [{ play: 8100 }, { stall: 1500 }, { play: 11900 }];

// expected: hand-derived. Times below are client ms.
const CASES = [
  {
    name: 'clean_run',
    why: 'Baseline: 0.5 s startup, plays 20 s straight at 1080p, ends normally.',
    build: { seed: 1, pieces: fullPlay },
    expected: {
      status: 'valid',
      metrics: {
        started: true, completed: true, terminal_reason: 'ended',
        startup_delay_s: 0.5, // playing at 1500 − request at 1000
        rebuffer_count: 0, rebuffer_duration_s: 0,
        tw_bitrate_kbps: 4700, prefix_only: false, // every fragment level 3 (avg 4 700 kbps)
        switch_count: 0, played_media_s: 20,
        buffer_mean_s: 6, buffer_p05_s: 6, low_buffer_fraction: 0, // all samples report 6 s
        sample_coverage: 1, reaction_anchor_n: null, // stable scenario has no anchors
        wall_session_s: 20.6, // finished at 21600 − request at 1000
      },
    },
  },
  {
    name: 'startup_waiting_only',
    why: 'Long 3 s startup with two waiting events before first play: must count as startup, never as a stall.',
    build: { seed: 2, startupMs: 3000, pieces: [{ play: 20000 }], startupDupWaitingAt: [1000] },
    expected: { status: 'valid', metrics: { startup_delay_s: 3, rebuffer_count: 0, rebuffer_duration_s: 0, completed: true } },
  },
  {
    name: 'one_stall',
    why: 'One 1.5 s stall after 8.1 s of playback.',
    build: { seed: 3, pieces: oneStall },
    expected: {
      status: 'valid',
      metrics: {
        rebuffer_count: 1, rebuffer_duration_s: 1.5, // waiting 9600 → playing 11100
        rebuffer_ratio: 1.5 / 21.5, // window first play 1500 → ended 23000
        completed: true, tw_bitrate_kbps: 4700,
      },
    },
  },
  {
    name: 'two_stalls',
    why: 'Two stalls (0.8 s and 2.0 s) must add up.',
    build: { seed: 4, pieces: [{ play: 5100 }, { stall: 800 }, { play: 5000 }, { stall: 2000 }, { play: 9900 }] },
    expected: { status: 'valid', metrics: { rebuffer_count: 2, rebuffer_duration_s: 2.8, completed: true } },
  },
  {
    name: 'duplicate_waiting',
    why: 'A second waiting event 300 ms into an open stall must not create a second stall.',
    build: { seed: 5, pieces: [{ play: 8100 }, { stall: 1500, dupAt: 300 }, { play: 11900 }] },
    expected: { status: 'valid', metrics: { rebuffer_count: 1, rebuffer_duration_s: 1.5 }, warningIncludes: 'duplicate waiting' },
  },
  {
    name: 'short_waiting_debounced',
    why: 'A 200 ms waiting blip is below the 250 ms threshold and is not a stall.',
    build: { seed: 6, pieces: [{ play: 8100 }, { stall: 200 }, { play: 11900 }] },
    expected: { status: 'valid', metrics: { rebuffer_count: 0, rebuffer_duration_s: 0 }, warningIncludes: 'under 250 ms' },
  },
  {
    name: 'timeout_censored_stall',
    why: 'Stalls at 8.1 s and never recovers; runner times out 5 s later. Stall is kept but marked censored; bitrate is prefix-only.',
    build: { seed: 7, pieces: [{ play: 8100 }, { stall: 5000 }], terminal: 'timeout' },
    expected: {
      status: 'valid',
      metrics: {
        completed: false, terminal_reason: 'timeout',
        rebuffer_count: 1, rebuffer_duration_s: 5, rebuffer_censored_n: 1,
        tw_bitrate_kbps: null, tw_bitrate_prefix_kbps: 4700, prefix_only: true,
        played_media_s: 8.1, // fragments 0–3 fully + 0.1 s of fragment 4
      },
    },
  },
  {
    name: 'fatal_error',
    why: 'Fatal network error after 10.1 s of playback: incomplete, terminal reason fatal_error.',
    build: { seed: 8, pieces: [{ play: 10100 }], terminal: 'fatal' },
    expected: {
      status: 'valid',
      // The playhead really reaches 10.1 s, but the last logged media time is the
      // 11500 ms sample (10.0 s); the reducer only counts what the logs prove.
      metrics: { completed: false, terminal_reason: 'fatal_error', rebuffer_count: 0, prefix_only: true, tw_bitrate_prefix_kbps: 4700, played_media_s: 10 },
    },
  },
  {
    name: 'played_quality_switch',
    why: 'First 3 fragments at 360p, the rest at 1080p: one up-switch; bitrate is media-time-weighted.',
    build: { seed: 9, pieces: fullPlay, levelForSn: (sn) => (sn < 3 ? 0 : 3) },
    expected: {
      status: 'valid',
      metrics: {
        switch_count: 1, up_switch_count: 1, down_switch_count: 0,
        switch_magnitude_kbps: 3940, // 4700 − 760
        tw_bitrate_kbps: 3518, // (6 s × 760 + 14 s × 4700) / 20 s
      },
    },
  },
  {
    name: 'requested_level_never_played',
    why: 'Player asks for 1080p (level_switching + a load that is never shown) but only 360p is ever played. Quality must follow what was played.',
    build: {
      seed: 10,
      pieces: fullPlay,
      levelForSn: () => 0,
      extra: [
        [15000, 'hls.level_switching', PLACEHOLDER_LADDER[3], 13.5],
        [15000, 'hls.frag_loading', { level: 3, sn: 9, startSec: 18, durationSec: 2, urlPath: '/stream/v1/r_x/v3/seg_9.ts' }],
      ],
    },
    expected: { status: 'valid', metrics: { tw_bitrate_kbps: 760, switch_count: 0 } },
  },
  {
    name: 'fragment_retry',
    why: 'A non-fatal fragment error and a retried request must not change played quality or end the run.',
    build: {
      seed: 11,
      pieces: fullPlay,
      extra: [
        [6000, 'hls.frag_loading', { level: 3, sn: 5, startSec: 10, durationSec: 2, urlPath: '/stream/v1/r_x/v3/seg_5.ts' }],
        [6200, 'hls.error', { fatal: false, errorType: 'networkError', details: 'fragLoadError', httpStatus: 500 }],
      ],
    },
    expected: { status: 'valid', metrics: { completed: true, tw_bitrate_kbps: 4700, switch_count: 0, rebuffer_count: 0 } },
  },
  {
    name: 'reaction_reacted',
    scenario: DROP,
    why: 'Capacity drops at scenario 10 s (client 11000). Last request before is level 3; first level-0 request is fragment 7 at client 14000 → 3.0 s.',
    build: { seed: 12, pieces: fullPlay, levelForSn: (sn) => (sn >= 7 ? 0 : 3) },
    expected: {
      status: 'valid',
      metrics: { reaction_anchor_n: 1, reaction_censored_n: 0, reaction_median_s: 3, reaction_worst_s: 3, down_switch_count: 1 },
    },
  },
  {
    name: 'reaction_already_safe',
    scenario: DROP,
    why: 'Already at level 0 before the drop: reaction is 0 s and flagged proactive/already-safe.',
    build: { seed: 13, pieces: fullPlay, levelForSn: () => 0 },
    expected: { status: 'valid', metrics: { reaction_anchor_n: 1, reaction_median_s: 0, reaction_censored_n: 0 }, anchorProactive: true },
  },
  {
    name: 'reaction_censored',
    scenario: DROP,
    why: 'Never drops to a safe level before the low plateau ends: anchor is censored and has no value.',
    build: { seed: 14, pieces: fullPlay, levelForSn: () => 3 },
    expected: { status: 'valid', metrics: { reaction_anchor_n: 1, reaction_censored_n: 1, reaction_median_s: null } },
  },
  {
    name: 'invalid_sequence_gap',
    why: 'Event seq 10 is missing (lost telemetry). The evidence cannot be trusted: rejected.',
    build: { seed: 15, pieces: fullPlay },
    mutate: (events) => events.filter((e) => e.seq !== 10),
    expected: { status: 'rejected', errorIncludes: 'sequence gap' },
  },
  {
    name: 'invalid_user_pause',
    why: 'Someone paused the video mid-run. Data is readable but the test conditions were broken: harness_invalid.',
    build: {
      seed: 16,
      pieces: fullPlay,
      extra: [
        [8000, 'media.pause', { reason: 'user' }, 6.5],
        [8001, 'media.play_requested', { muted: true, autoplay: false }],
      ],
    },
    expected: { status: 'harness_invalid', errorIncludes: 'paused' },
  },
  {
    name: 'invalid_low_sample_coverage',
    why: '10 s of buffer samples are missing, so coverage is ~51% (< 95%): harness_invalid.',
    build: { seed: 17, pieces: fullPlay, dropSamples: [5000, 15000] },
    expected: { status: 'harness_invalid', errorIncludes: 'coverage', metrics: { sample_coverage: 0.5125 } },
  },
  {
    name: 'invalid_tampered_after_finish',
    why: 'events.ndjson was edited after the server hashed it at finish time. Evidence can no longer be trusted: rejected.',
    build: { seed: 18, pieces: fullPlay },
    tamper: (text) => text.replace('"forwardBufferSec":6', '"forwardBufferSec":9'),
    expected: { status: 'rejected', errorIncludes: 'modified after the run finished' },
  },
  {
    name: 'server_aborted',
    why: 'The runner aborted the run (status ABORTED). The server already knows the session was not clean: harness_invalid, nothing computed.',
    build: { seed: 19, pieces: fullPlay },
    runOverrides: { status: 'ABORTED', finishReason: 'browser crashed' },
    expected: { status: 'harness_invalid', errorIncludes: 'ABORTED' },
  },
];

export const FIXTURE_CONTEXT = {
  experiment: 'tests/fixtures/analysis/context/experiment.json',
  scenarioManifest: 'tests/fixtures/analysis/context/scenario-manifest.json',
  packageManifest: 'tests/fixtures/analysis/context/media-package.json',
};

// Fixture apparatus: same shapes as Galib's real files, tiny values.
function writeContext() {
  const dir = path.join(here, 'context');
  fs.mkdirSync(dir, { recursive: true });
  const experiment = readJson(path.join(repoRoot, 'configs/experiment.v1.json'));
  experiment.id = 'fixture-experiment';
  experiment.scenarioFiles = ['tests/fixtures/analysis/scenario.stable.json', 'tests/fixtures/analysis/scenario.drop.json'];
  const pkg = {
    schemaVersion: '1.0.0',
    assetId: 'fixture',
    durationSeconds: CLIP_SEC,
    renditions: PLACEHOLDER_LADDER.map((l) => ({ id: `v${l.level}`, width: l.width, height: l.height, measuredPeakBps: l.bitrateBps, measuredAverageBps: l.averageBitrateBps, codecs: l.codecs })),
  };
  const pkgText = `${JSON.stringify(pkg, null, 2)}\n`;
  experiment.packageManifestSha256 = crypto.createHash('sha256').update(pkgText).digest('hex');
  const scen = (file) => readJson(path.join(repoRoot, file));
  const manifest = {
    schemaVersion: '1.0.0',
    packageManifestSha256: experiment.packageManifestSha256,
    scenarios: [
      { id: 'fixture-stable', path: experiment.scenarioFiles[0], sha256: sha256Canonical(scen(experiment.scenarioFiles[0])), anchors: [] },
      {
        id: 'fixture-drop',
        path: experiment.scenarioFiles[1],
        sha256: sha256Canonical(scen(experiment.scenarioFiles[1])),
        anchors: [
          { id: 'low-anchor', atMs: 10000, kind: 'adverse', fromPhaseId: 'high', toPhaseId: 'low', fromKbps: 6000, toKbps: 1200 },
          { id: 'recovery-anchor', atMs: 20000, kind: 'recovery', fromPhaseId: 'low', toPhaseId: 'recovery', fromKbps: 1200, toKbps: 6000 },
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(dir, 'experiment.json'), `${JSON.stringify(experiment, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'media-package.json'), pkgText);
  fs.writeFileSync(path.join(dir, 'scenario-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function buildAll(outDir = here) {
  writeContext();
  const ctx = loadContext(FIXTURE_CONTEXT);
  fs.rmSync(path.join(outDir, 'cases'), { recursive: true, force: true });
  for (const c of CASES) {
    const caseDir = path.join(outDir, 'cases', c.name);
    const { runId, events, serverRequests } = script(c.build);
    const dir = path.join(caseDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    const finalEvents = c.mutate ? c.mutate(events) : events;
    fs.writeFileSync(path.join(dir, 'events.ndjson'), toNdjson(finalEvents));
    fs.writeFileSync(path.join(dir, 'server-requests.ndjson'), toNdjson(serverRequests));
    fs.writeFileSync(path.join(dir, 'scheduler-writes.ndjson'), '');
    const artifacts = Object.fromEntries(RAW_ARTIFACTS.map((name) => [name, sha256File(path.join(dir, name))]));
    const scenarioId = c.scenario ?? STABLE;
    const iso = (ms) => new Date(EPOCH_BASE_MS + ms).toISOString();
    const run = {
      schemaVersion: '1.0.0', runId, requestId: '00000000-0000-4000-8000-0000000000' + String(c.build.seed).padStart(2, '0'),
      status: 'COMPLETED', experimentId: ctx.experiment.id, experimentSha256: ctx.experimentSha256, scenarioId,
      scenarioSha256: ctx.scenarios.get(scenarioId).computedSha256, packageSha256: ctx.packageSha256, policyId: 'default-hlsjs',
      repetition: 1, orderSeed: 1, clientLabel: 'synthetic-fixture', gitCommit: '0'.repeat(40), gitDirty: false,
      createdAt: iso(0), startedAt: iso(Z), finishedAt: iso(30000), finishReason: 'ended', failureCode: null, warnings: [], artifacts,
      startRequest: { clientSendEpochMs: EPOCH_BASE_MS + Z, clientSendMonoMs: Z }, serverRunStartEpochMs: EPOCH_BASE_MS + Z, serverRunStartMonoMs: 5000,
      ...c.runOverrides,
    };
    fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
    if (c.tamper) {
      const file = path.join(dir, 'events.ndjson');
      fs.writeFileSync(file, c.tamper(fs.readFileSync(file, 'utf8')));
    }
    fs.writeFileSync(path.join(caseDir, 'expected.json'), `${JSON.stringify({ case: c.name, why: c.why, ...c.expected }, null, 2)}\n`);
  }
  return CASES.map((c) => c.name);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = buildAll();
  console.log(`Built ${names.length} fixture cases in tests/fixtures/analysis/cases/`);
}
