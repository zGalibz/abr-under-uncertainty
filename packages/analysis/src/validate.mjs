// Raw-evidence validator.
//
// Each run gets one of three statuses:
//   valid           - evidence is trustworthy and the run counts
//   harness_invalid - evidence is readable but the test conditions were broken
//                     (pause, seek, hidden tab, too few samples...). Kept on disk,
//                     excluded from summaries, and may be rerun with lineage.
//   rejected        - evidence itself cannot be trusted (schema errors, sequence
//                     gaps, wrong run ID...). Nothing is computed from it.

import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readJson, repoRoot } from './io.mjs';

const MIN_SAMPLE_COVERAGE = 0.95;
const REQUIRED_RUN_FIELDS = ['runId', 'policyId', 'scenarioId', 'repetition', 'clientMonoAtScenarioZeroMs'];
const REQUIRED_EVENTS = ['client.ready', 'hls.manifest_parsed', 'media.play_requested', 'client.finished'];

let telemetryValidator = null;
function getTelemetryValidator() {
  if (!telemetryValidator) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    telemetryValidator = ajv.compile(readJson(path.join(repoRoot, 'contracts/schemas/telemetry-event.schema.json')));
  }
  return telemetryValidator;
}

// Structural checks: can these events be trusted at all?
export function validateStructure({ run, events, parseErrors }) {
  const errors = [...parseErrors];
  for (const f of REQUIRED_RUN_FIELDS) if (run[f] === undefined) errors.push(`run.json is missing ${f}`);

  const validateEvent = getTelemetryValidator();
  events.forEach((e) => {
    if (!validateEvent(e)) {
      const msg = validateEvent.errors.slice(0, 3).map((x) => `${x.instancePath || '/'} ${x.message}`).join('; ');
      errors.push(`seq ${e.seq ?? '?'} (${e.type ?? '?'}): schema violation: ${msg}`);
    }
    if (e.runId !== run.runId) errors.push(`seq ${e.seq}: runId ${e.runId} does not match run.json ${run.runId}`);
  });

  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  sorted.forEach((e, i) => {
    if (e.seq !== i) {
      if (i > 0 && e.seq === sorted[i - 1].seq) errors.push(`seq ${e.seq} appears more than once`);
      else errors.push(`sequence gap: expected seq ${i}, found ${e.seq}`);
    }
    if (i > 0 && e.clientMonoMs < sorted[i - 1].clientMonoMs) {
      errors.push(`seq ${e.seq}: clientMonoMs goes backwards (${e.clientMonoMs} < ${sorted[i - 1].clientMonoMs})`);
    }
  });
  events.forEach((e, i) => {
    if (i > 0 && e.seq < events[i - 1].seq) errors.push(`file order: seq ${e.seq} written after seq ${events[i - 1].seq}`);
  });

  const types = new Set(events.map((e) => e.type));
  for (const req of REQUIRED_EVENTS) if (!types.has(req)) errors.push(`missing required event ${req}`);
  const last = sorted.at(-1);
  if (last && last.type !== 'client.finished') errors.push(`last event is ${last.type}, expected client.finished`);

  for (const e of events) {
    if (e.type === 'abr.decision' && e.data.policyId !== run.policyId) {
      errors.push(`seq ${e.seq}: abr.decision policy ${e.data.policyId} does not match run policy ${run.policyId}`);
      break;
    }
  }
  return errors;
}

// Harness checks need the reduced timeline (first play, terminal), so they
// run after the reducer.
export function validateHarness({ events }, reduced) {
  const problems = [];
  const warnings = [];
  const { tFirstPlayMs, tTerminalMs, sampleGaps } = reduced.detail;
  const during = (e) => tFirstPlayMs !== null && e.clientMonoMs > tFirstPlayMs && e.clientMonoMs < tTerminalMs;
  for (const e of events) {
    if (!during(e)) continue;
    if (e.type === 'media.pause' && e.data.reason !== 'ended') problems.push(`seq ${e.seq}: playback paused (${e.data.reason}) during the run`);
    if (e.type === 'media.seeking') problems.push(`seq ${e.seq}: seek during the run`);
    if (e.type === 'media.rate_changed' && e.data.playbackRate !== 1) problems.push(`seq ${e.seq}: playback rate changed to ${e.data.playbackRate}`);
    if (e.type === 'client.visibility_changed' && e.data.state !== 'visible') problems.push(`seq ${e.seq}: tab became ${e.data.state}`);
  }
  const { sample_coverage: coverage } = reduced.metrics;
  if (coverage !== null && coverage < MIN_SAMPLE_COVERAGE) {
    problems.push(`sample coverage ${(coverage * 100).toFixed(1)}% is below ${MIN_SAMPLE_COVERAGE * 100}%`);
  }
  if (sampleGaps > 0) warnings.push(`${sampleGaps} sample gap(s) longer than 500 ms`);
  if (reduced.detail.duplicateWaiting > 0) warnings.push(`${reduced.detail.duplicateWaiting} duplicate waiting event(s) ignored`);
  if (reduced.detail.debouncedWaiting > 0) warnings.push(`${reduced.detail.debouncedWaiting} waiting interval(s) under 250 ms ignored`);
  if (!reduced.metrics.started) warnings.push('playback never started');
  return { problems, warnings };
}

// Matrix check across all runs: exactly one valid run per policy × trace × repeat.
export function validateMatrix(results, experiment) {
  const errors = [];
  const seen = new Map();
  for (const r of results) {
    if (seen.has(r.runId)) errors.push(`duplicate run ID ${r.runId}`);
    seen.set(r.runId, true);
  }
  const traces = experiment.scenarioFiles.map((f) => readJson(path.join(repoRoot, f)).id);
  const policies = experiment.player.policies;
  const repeats = experiment.execution.repetitionsPerCell;
  const cells = [];
  for (const policy of policies) {
    for (const trace of traces) {
      for (let rep = 1; rep <= repeats; rep += 1) {
        const valid = results.filter((r) => r.status === 'valid' && r.policyId === policy && r.scenarioId === trace && r.repetition === rep);
        const attempts = results.filter((r) => r.policyId === policy && r.scenarioId === trace && r.repetition === rep);
        cells.push({ policy, trace, repetition: rep, valid: valid.length, attempts: attempts.length });
        if (valid.length === 0) errors.push(`missing valid run: ${policy} / ${trace} / repeat ${rep}`);
        if (valid.length > 1) errors.push(`more than one valid run: ${policy} / ${trace} / repeat ${rep}`);
      }
    }
  }
  const extra = results.filter((r) => !policies.includes(r.policyId) || !traces.includes(r.scenarioId));
  for (const r of extra) errors.push(`run ${r.runId} has policy/trace outside the experiment matrix (${r.policyId} / ${r.scenarioId})`);
  return {
    expected: policies.length * traces.length * repeats,
    validCount: results.filter((r) => r.status === 'valid').length,
    errors,
    cells,
  };
}
