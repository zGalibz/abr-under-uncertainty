// One-command pipeline: raw runs → validation → metrics → summaries → charts.
//
//   node packages/analysis/src/analyze.mjs --raw results/raw --out results [--order results/run-order.json]
//
// Runs are read in the exact format Galib's server writes (run.json,
// events.ndjson, server-requests.ndjson) and checked against the frozen
// apparatus: configs/experiment.v1.json, configs/scenarios/manifest.json and
// media/package.json.
//
// Writes <out>/summary/*.csv, <out>/summary/validation_report.json and
// <out>/figures/*.svg. Re-running on the same raw data gives the same output.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { renderAll } from './charts.mjs';
import { loadContext } from './context.mjs';
import { listRunDirs, loadRun, readJson, repoRoot, writeCsv, writeJson } from './io.mjs';
import { evaluateRun } from './evaluate.mjs';
import { clientMonoAtRunZero } from './reduce.mjs';
import { median } from './stats.mjs';
import { buildCells, buildCompletion, buildPairedDeltas } from './summarize.mjs';
import { validateMatrix } from './validate.mjs';

const RUN_COLUMNS = [
  'run_id', 'policy_id', 'trace_id', 'repeat_id', 'order_index', 'valid_harness', 'started', 'completed', 'terminal_reason',
  'startup_delay_s', 'rebuffer_count', 'rebuffer_duration_s', 'rebuffer_ratio', 'tw_bitrate_kbps', 'tw_bitrate_prefix_kbps',
  'prefix_only', 'switch_count', 'up_switch_count', 'down_switch_count', 'switches_per_min', 'switch_magnitude_kbps',
  'buffer_mean_s', 'buffer_p05_s', 'low_buffer_fraction', 'reaction_anchor_n', 'reaction_median_s', 'reaction_worst_s',
  'played_media_s', 'wall_session_s', 'start_skew_ms', 'sample_coverage', 'raw_sha256',
  // extra columns beyond the framework's required list
  'validation_status', 'rebuffer_censored_n', 'reaction_censored_n', 'reaction_not_exposed_n', 'rerun_of',
  // exploratory diagnostics added after data collection (not pre-registered)
  'download_end_s', 'media_mb',
];
const CELL_COLUMNS = ['policy_id', 'trace_id', 'metric', 'unit', 'n_valid', 'values_json', 'median', 'min', 'max', 'mean', 'sample_sd', 'n_complete'];
const PAIRED_COLUMNS = ['trace_id', 'repeat_id', 'metric', 'default_value', 'conservative_value', 'delta_c_minus_d', 'improvement_signed'];
const ANCHOR_COLUMNS = ['run_id', 'policy_id', 'trace_id', 'repeat_id', 'anchor_id', 't_rel_ms', 'plateau_end_ms', 'capacity_before_bps',
  'capacity_after_bps', 'safe_level_before', 'safe_level_after', 'target_level', 'level_pre', 'status', 'reaction_s', 'censored', 'proactive_or_already_safe'];
const COMPLETION_COLUMNS = ['policy_id', 'trace_id', 'completed', 'terminal_reasons'];

// Representative run for time-series figures (framework §9 rule 9): the run
// whose total rebuffering is the cell median; ties broken by closeness to the
// median bitrate, then by lowest repeat.
function pickRepresentative(cellRuns) {
  const medRebuf = median(cellRuns.map((r) => r.rebuffer_duration_s));
  const medBitrate = median(cellRuns.map((r) => r.tw_bitrate_kbps ?? r.tw_bitrate_prefix_kbps));
  return [...cellRuns].sort((a, b) => {
    const da = Math.abs(a.rebuffer_duration_s - medRebuf) - Math.abs(b.rebuffer_duration_s - medRebuf);
    if (da !== 0) return da;
    const ba = Math.abs((a.tw_bitrate_kbps ?? a.tw_bitrate_prefix_kbps) - medBitrate) - Math.abs((b.tw_bitrate_kbps ?? b.tw_bitrate_prefix_kbps) - medBitrate);
    return ba !== 0 ? ba : a.repeat_id - b.repeat_id;
  })[0];
}

// Achieved media goodput: bytes the server's shaper actually wrote for this
// run (scheduler-writes.ndjson, scenario clock), in 1-second bins. It is a
// measurement and is always drawn apart from the configured capacity, which is
// only a target (framework §10.1). Seconds with no media writes (player idle
// because its buffer was full) have no bar.
function achievedGoodput(loaded, rel, end) {
  const zero = clientMonoAtRunZero(loaded.run);
  const file = path.join(loaded.dir, 'scheduler-writes.ndjson');
  if (zero === null || !fs.existsSync(file)) return [];
  const bins = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const w = JSON.parse(line);
    if (w.kind !== 'write' || !(w.bytes > 0)) continue;
    const second = Math.floor(w.atRunMs / 1000);
    bins.set(second, (bins.get(second) ?? 0) + w.bytes);
  }
  return [...bins].sort((a, b) => a[0] - b[0])
    .map(([second, bytes]) => ({ t: rel(zero + second * 1000), t2: rel(zero + (second + 1) * 1000), kbps: (bytes * 8) / 1000 }))
    .filter((b) => b.t >= 0 && b.t <= end);
}

function buildSeries(loaded, reduced, ctx) {
  const { run, events } = loaded;
  const { scenario } = ctx.scenarios.get(run.scenarioId);
  const tReq = events.find((e) => e.type === 'media.play_requested').clientMonoMs;
  const rel = (ms) => (ms - tReq) / 1000;
  const end = rel(reduced.detail.tTerminalMs);
  const capacity = scenario.phases.map((p) => ({ t: Math.max(0, rel(clientMonoAtRunZero(run) + p.startMs)), kbps: p.downlinkKbps }))
    .filter((p) => p.t <= end);
  capacity.push({ t: end, kbps: capacity.at(-1).kbps });
  const bitrateByLevel = new Map(reduced.detail.ladder.map((l) => [l.level, l.averageBitrateBps ?? l.bitrateBps]));
  const played = events.filter((e) => e.type === 'hls.frag_changed')
    .map((e) => ({ t: rel(e.clientMonoMs), kbps: (bitrateByLevel.get(e.data.level) ?? e.data.bitrateBps) / 1000 }));
  if (played.length) played.push({ t: end, kbps: played.at(-1).kbps });
  return {
    runId: run.runId,
    policy: run.policyId,
    trace: run.scenarioId,
    capacity,
    achieved: achievedGoodput(loaded, rel, end),
    played,
    buffer: events.filter((e) => e.type === 'media.sample').map((e) => ({ t: rel(e.clientMonoMs), s: e.data.forwardBufferSec })),
    stalls: reduced.detail.stalls.map((s) => ({ start: rel(s.startMs), end: rel(s.endMs) })),
  };
}

// The run order is decided before any run happens (runner's run-order file).
// Galib's run.json does not carry it, so it is joined in here when available.
function orderLookup(orderFile) {
  if (!orderFile) return () => null;
  const { order } = readJson(orderFile);
  const map = new Map(order.map((o) => [`${o.policy}|${o.trace}|${o.repetition}`, o.orderIndex]));
  return (run) => map.get(`${run.policyId}|${run.scenarioId}|${run.repetition}`) ?? null;
}

// Rerun lineage: within one policy × trace × repeat cell, each attempt
// points at the attempt created just before it.
function lineage(runs) {
  const prev = new Map();
  const byCell = new Map();
  for (const r of [...runs].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
    const key = `${r.policyId}|${r.scenarioId}|${r.repetition}`;
    if (byCell.has(key)) prev.set(r.runId, byCell.get(key));
    byCell.set(key, r.runId);
  }
  return prev;
}

// The server writes every run into results/raw (it has one results root):
// counted runs, warm-ups, dry runs, demos and manual player-page runs. Only
// runs whose clientLabel is on this allowlist are counted by default; any
// other dataset (dry runs, synthetic data) must be selected with --labels.
export const COUNTED_LABELS = ['runner-counted'];

export async function analyze({ rawDir, outDir, contextFiles, orderFile, labels = null, charts = true, log = console.log }) {
  const ctx = loadContext(contextFiles);
  const orderOf = orderLookup(orderFile);
  const runDirs = listRunDirs(rawDir);
  log(`Found ${runDirs.length} run(s) in ${path.relative(repoRoot, rawDir) || rawDir}`);

  const keep = (run) => (labels ?? COUNTED_LABELS).includes(run.clientLabel);
  const allRuns = runDirs.map(loadRun);
  const loadedRuns = allRuns.filter((l) => keep(l.run));
  if (loadedRuns.length !== allRuns.length) {
    log(`Skipping ${allRuns.length - loadedRuns.length} run(s) by label (${labels ? `keeping only ${labels.join(', ')}` : `counted labels: ${COUNTED_LABELS.join(', ')}`})`);
  }
  const rerunOf = lineage(loadedRuns.map((l) => l.run));
  const results = [];
  const runRows = [];
  const anchorRows = [];
  const loadedById = new Map();
  for (const loaded of loadedRuns) {
    const { run } = loaded;
    const entry = { runId: run.runId, dir: path.relative(repoRoot, loaded.dir), policyId: run.policyId, scenarioId: run.scenarioId, repetition: run.repetition, rerunOf: rerunOf.get(run.runId) ?? null };
    const idRow = { run_id: run.runId, policy_id: run.policyId, trace_id: run.scenarioId, repeat_id: run.repetition, order_index: orderOf(run), raw_sha256: loaded.rawSha256, rerun_of: entry.rerunOf };
    const { status, errors, warnings, reduced } = evaluateRun(loaded, ctx);
    results.push({ ...entry, status, errors, warnings });
    runRows.push({ ...(reduced?.metrics ?? {}), ...idRow, valid_harness: status === 'valid', validation_status: status });
    if (status === 'valid') {
      for (const r of reduced.detail.reactions) anchorRows.push({ ...r, policy_id: run.policyId, trace_id: run.scenarioId, repeat_id: run.repetition });
      loadedById.set(run.runId, { loaded, reduced });
    }
  }

  const matrix = validateMatrix(results, ctx);
  const valid = runRows.filter((r) => r.validation_status === 'valid');
  const cells = buildCells(valid);
  const paired = buildPairedDeltas(valid);
  const completion = buildCompletion(valid);

  const summaryDir = path.join(outDir, 'summary');
  runRows.sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0) || String(a.run_id).localeCompare(String(b.run_id)));
  writeCsv(path.join(summaryDir, 'runs.csv'), RUN_COLUMNS, runRows);
  writeCsv(path.join(summaryDir, 'cells.csv'), CELL_COLUMNS, cells);
  writeCsv(path.join(summaryDir, 'paired_deltas.csv'), PAIRED_COLUMNS, paired);
  writeCsv(path.join(summaryDir, 'reaction_anchors.csv'), ANCHOR_COLUMNS, anchorRows);
  writeCsv(path.join(summaryDir, 'completion.csv'), COMPLETION_COLUMNS, completion);
  const report = {
    experimentId: ctx.experiment.id,
    // Synthetic runs are labelled through clientLabel, the only free-text field in run.json.
    synthetic: loadedRuns.some((l) => String(l.run.clientLabel).startsWith('synthetic')),
    apparatus: { experimentSha256: ctx.experimentSha256, packageSha256: ctx.packageSha256, files: ctx.files },
    counts: {
      runs: results.length,
      valid: results.filter((r) => r.status === 'valid').length,
      harnessInvalid: results.filter((r) => r.status === 'harness_invalid').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
    },
    matrix,
    runs: results,
  };
  writeJson(path.join(summaryDir, 'validation_report.json'), report);

  let figures = [];
  if (charts && valid.length) {
    const timeseries = [];
    for (const trace of ['gradual-v1', 'volatile-v1']) {
      for (const policy of ctx.experiment.player.policies) {
        const cellRuns = valid.filter((r) => r.trace_id === trace && r.policy_id === policy);
        if (!cellRuns.length) continue;
        const rep = pickRepresentative(cellRuns);
        const { loaded, reduced } = loadedById.get(rep.run_id);
        timeseries.push(buildSeries(loaded, reduced, ctx));
      }
    }
    const traces = [...ctx.scenarios.values()]
      .filter((s) => ctx.experiment.scenarioFiles.includes(s.path))
      .map((s) => ({ id: s.id, phases: s.scenario.phases }));
    figures = await renderAll({ runs: valid, cells, anchorRows, timeseries, traces, ladder: ctx.ladder, outDir: path.join(outDir, 'figures') });
  }

  log(`Validation: ${report.counts.valid} valid, ${report.counts.harnessInvalid} harness-invalid, ${report.counts.rejected} rejected`);
  log(`Matrix: ${matrix.validCount}/${matrix.expected} cells filled${matrix.errors.length ? ` — ${matrix.errors.length} problem(s)` : ' — complete'}`);
  for (const r of results.filter((x) => x.status !== 'valid')) log(`  ${r.status}: ${r.runId} — ${r.errors[0]}`);
  for (const e of matrix.errors) log(`  matrix: ${e}`);
  log(`Wrote summaries to ${path.relative(repoRoot, summaryDir)} and ${figures.length} figure(s) to ${path.relative(repoRoot, path.join(outDir, 'figures'))}`);
  return { report, runRows, cells, paired, anchorRows, figures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      raw: { type: 'string', default: 'results/raw' },
      out: { type: 'string', default: 'results' },
      order: { type: 'string' },
      labels: { type: 'string' }, // comma-separated clientLabels to keep, e.g. runner-dry-run
      'no-charts': { type: 'boolean', default: false },
    },
  });
  const resolve = (p) => path.resolve(repoRoot, p);
  const { report } = await analyze({
    rawDir: resolve(values.raw),
    outDir: resolve(values.out),
    orderFile: values.order ? resolve(values.order) : null,
    labels: values.labels ? values.labels.split(',') : null,
    charts: !values['no-charts'],
  });
  process.exitCode = report.counts.rejected > 0 || report.matrix.errors.length > 0 ? 1 : 0;
}
