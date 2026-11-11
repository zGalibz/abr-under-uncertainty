// Raw-evidence validator.
//
// Each run gets one of three statuses:
//   valid           - evidence is trustworthy and the run counts
//   harness_invalid - the test conditions were broken (server marked the run
//                     FAILED/ABORTED, pause, seek, hidden tab, too few
//                     samples...). Kept on disk, excluded from summaries, and
//                     the cell is rerun.
//   rejected        - the evidence itself cannot be trusted (schema errors,
//                     sequence gaps, hash mismatch, wrong apparatus...).
//                     Nothing is computed from it.

import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readJson, repoRoot } from './io.mjs';
import { ladderFromEvents } from './reduce.mjs';

const MIN_SAMPLE_COVERAGE = 0.95;
const REQUIRED_EVENTS = ['client.ready', 'hls.manifest_parsed', 'media.play_requested', 'client.finished'];

let validators = null;
function getValidators() {
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const compile = (name) => ajv.compile(readJson(path.join(repoRoot, 'contracts/schemas', name)));
    validators = {
      event: compile('telemetry-event.schema.json'),
      run: compile('run.schema.json'),
      request: compile('server-request.schema.json'),
    };
  }
  return validators;
}

const schemaMessage = (v) => v.errors.slice(0, 3).map((x) => `${x.instancePath || '/'} ${x.message}`).join('; ');

// Was this run produced by exactly the frozen apparatus, and are the raw
// files byte-identical to what the server hashed at finish time?
function validateProvenance({ run, fileHashes }, ctx) {
  const errors = [];
  const entry = ctx.scenarios.get(run.scenarioId);
  if (!entry) errors.push(`scenario ${run.scenarioId} is not in the scenario manifest`);
  else if (run.scenarioSha256 !== entry.computedSha256) errors.push(`scenarioSha256 does not match frozen ${run.scenarioId}`);
  if (run.experimentSha256 !== ctx.experimentSha256) errors.push('experimentSha256 does not match configs/experiment.v1.json');
  if (run.packageSha256 !== ctx.packageSha256) errors.push('packageSha256 does not match media/package.json');
  for (const [name, recorded] of Object.entries(run.artifacts ?? {})) {
    if (!fileHashes[name]) errors.push(`${name} is recorded in run.json but missing on disk`);
    else if (fileHashes[name] !== recorded) errors.push(`${name} was modified after the run finished (SHA-256 mismatch)`);
  }
  return errors;
}

// The ladder the player saw must be the measured package ladder.
function validateLadder(events, ctx) {
  const seen = ladderFromEvents(events);
  if (seen.length === 0) return [];
  if (seen.length !== ctx.ladder.length) return [`player saw ${seen.length} levels, package has ${ctx.ladder.length}`];
  const errors = [];
  seen.forEach((l, i) => {
    const want = ctx.ladder[i];
    if (l.bitrateBps !== want.bitrateBps || l.width !== want.width || l.height !== want.height) {
      errors.push(`level ${i}: player saw ${l.width}x${l.height}@${l.bitrateBps}, package has ${want.width}x${want.height}@${want.bitrateBps}`);
    }
  });
  return errors;
}

// Structural checks: can these files be trusted at all?
export function validateStructure(loaded, ctx) {
  const { run, events, serverRequests, parseErrors } = loaded;
  const v = getValidators();
  const errors = [...parseErrors];
  if (!v.run(run)) errors.push(`run.json: schema violation: ${schemaMessage(v.run)}`);
  if (path.basename(loaded.dir) !== run.runId) errors.push(`folder name ${path.basename(loaded.dir)} does not match runId ${run.runId}`);
  errors.push(...validateProvenance(loaded, ctx));

  events.forEach((e) => {
    if (!v.event(e)) errors.push(`seq ${e.seq ?? '?'} (${e.type ?? '?'}): schema violation: ${schemaMessage(v.event)}`);
    if (e.runId !== run.runId) errors.push(`seq ${e.seq}: runId ${e.runId} does not match run.json ${run.runId}`);
  });
  (serverRequests ?? []).forEach((r, i) => {
    if (!v.request(r)) errors.push(`server-requests line ${i + 1}: schema violation: ${schemaMessage(v.request)}`);
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
  errors.push(...validateLadder(events, ctx));
  return errors;
}

// The server already knows when a run was not a clean session.
export function serverStatusProblem(run) {
  if (run.status === 'COMPLETED') return null;
  if (run.status === 'FAILED' || run.status === 'ABORTED') return `server marked run ${run.status} (${run.failureCode ?? run.finishReason ?? 'no reason given'})`;
  return `run was never finalized (status ${run.status})`;
}

// Harness checks need the reduced timeline (first play, terminal), so they
// run after the reducer.
export function validateHarness({ events, serverRequests }, reduced) {
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
  if (!serverRequests) warnings.push('server-requests.ndjson missing: reaction time cannot be computed');
  if (sampleGaps > 0) warnings.push(`${sampleGaps} sample gap(s) longer than 500 ms`);
  if (reduced.detail.duplicateWaiting > 0) warnings.push(`${reduced.detail.duplicateWaiting} duplicate waiting event(s) ignored`);
  if (reduced.detail.debouncedWaiting > 0) warnings.push(`${reduced.detail.debouncedWaiting} waiting interval(s) under 250 ms ignored`);
  if (!reduced.metrics.started) warnings.push('playback never started');
  return { problems, warnings };
}

// Matrix check across all runs: exactly one valid run per policy × trace × repeat.
export function validateMatrix(results, ctx) {
  const { experiment } = ctx;
  const errors = [];
  const seen = new Set();
  for (const r of results) {
    if (seen.has(r.runId)) errors.push(`duplicate run ID ${r.runId}`);
    seen.add(r.runId);
  }
  const traces = [...ctx.scenarios.values()].filter((s) => experiment.scenarioFiles.includes(s.path)).map((s) => s.id);
  const policies = experiment.player.policies;
  const repeats = experiment.execution.repetitionsPerCell;
  const cells = [];
  for (const policy of policies) {
    for (const trace of traces) {
      for (let rep = 1; rep <= repeats; rep += 1) {
        const inCell = (r) => r.policyId === policy && r.scenarioId === trace && r.repetition === rep;
        const valid = results.filter((r) => r.status === 'valid' && inCell(r));
        cells.push({ policy, trace, repetition: rep, valid: valid.length, attempts: results.filter(inCell).length });
        if (valid.length === 0) errors.push(`missing valid run: ${policy} / ${trace} / repeat ${rep}`);
        if (valid.length > 1) errors.push(`more than one valid run: ${policy} / ${trace} / repeat ${rep}`);
      }
    }
  }
  for (const r of results.filter((x) => !policies.includes(x.policyId) || !traces.includes(x.scenarioId))) {
    errors.push(`run ${r.runId} has policy/trace outside the experiment matrix (${r.policyId} / ${r.scenarioId})`);
  }
  return {
    expected: policies.length * traces.length * repeats,
    validCount: results.filter((r) => r.status === 'valid').length,
    errors,
    cells,
  };
}
