// Run orchestration (TEAM_ROLES §6 C1).
//
// For each cell (policy × trace × repeat) the runner:
//   1. creates the run on Galib's server and checks the server is using the
//      same frozen apparatus as this checkout (experiment/scenario/package hashes);
//   2. opens the player in a fresh browser context with the runId + policyId;
//   3. watches the run state without touching the page (no human interaction);
//   4. aborts it if the browser fails or the watchdog expires;
//   5. validates the raw evidence immediately with the analysis rules;
//   6. records every attempt in an append-only ledger, and reruns a cell only
//      when the attempt was harness-invalid (never because of a bad outcome).

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateRun } from '../../analysis/src/evaluate.mjs';
import { listRunDirs, loadRun } from '../../analysis/src/io.mjs';
import { TERMINAL_STATUSES } from './api.mjs';

// clientLabel marks what a run is for. The analysis excludes warm-up and
// dry-run labels from the counted dataset.
export const LABELS = { warmup: 'runner-warmup', 'dry-run': 'runner-dry-run', counted: 'runner-counted' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StopSession extends Error {}

export function playerUrlFor(playerUrl, { apiBase, runId, policyId, maxWallMs }) {
  const u = new URL(playerUrl);
  u.searchParams.set('api', apiBase);
  u.searchParams.set('runId', runId);
  u.searchParams.set('policyId', policyId);
  u.searchParams.set('maxWallMs', String(maxWallMs));
  return u.toString();
}

function appendLedger(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// The server computes these hashes from its own files; if they differ from
// this checkout, the server is running a different apparatus.
function apparatusMismatch(run, ctx) {
  const problems = [];
  if (run.experimentSha256 !== ctx.experimentSha256) problems.push('experiment config');
  if (run.packageSha256 !== ctx.packageSha256) problems.push('media package');
  if (run.scenarioSha256 !== ctx.scenarios.get(run.scenarioId)?.computedSha256) problems.push(`scenario ${run.scenarioId}`);
  return problems;
}

export async function runAttempt(cell, deps) {
  const { api, driver, ctx, mode, git, playerUrl, rawDir, pollMs = 1000, graceMs = 30000, log } = deps;
  const maxWallMs = ctx.experiment.stopPolicy.maxWallDurationMs;
  const run = await api.createRun({
    requestId: randomUUID(),
    experimentId: ctx.experiment.id,
    scenarioId: cell.trace,
    policyId: cell.policy,
    repetition: cell.repetition,
    orderSeed: ctx.experiment.execution.orderSeed,
    clientLabel: LABELS[mode],
    gitCommit: git.commit,
    gitDirty: git.dirty,
  });
  const mismatch = apparatusMismatch(run, ctx);
  if (mismatch.length) {
    await api.abortRun(run.runId, `runner: apparatus mismatch (${mismatch.join(', ')})`).catch(() => {});
    throw new StopSession(`server is not using this checkout's frozen ${mismatch.join(', ')}; stop and sync with Galib`);
  }
  log(`  run ${run.runId} created; opening player`);

  const session = await driver.openSession({ url: playerUrlFor(playerUrl, { apiBase: api.base, runId: run.runId, policyId: cell.policy, maxWallMs }) });
  const deadline = Date.now() + maxWallMs + graceMs;
  let state = run;
  let abortReason = null;
  while (!TERMINAL_STATUSES.has(state.status)) {
    await sleep(pollMs);
    state = await api.getRun(run.runId);
    if (TERMINAL_STATUSES.has(state.status)) break;
    if (session.failure) abortReason = `runner: ${session.failure}`;
    else if (Date.now() > deadline) abortReason = `runner watchdog: no terminal state after ${maxWallMs + graceMs} ms`;
    if (abortReason) {
      state = await api.abortRun(run.runId, abortReason).catch(async () => api.getRun(run.runId));
      break;
    }
  }
  await session.close();

  const runDir = path.join(rawDir, run.runId);
  if (session.consoleLines.length && fs.existsSync(runDir)) {
    fs.writeFileSync(path.join(runDir, 'console.log'), `${session.consoleLines.join('\n')}\n`);
  }
  const outcome = fs.existsSync(path.join(runDir, 'run.json'))
    ? evaluateRun(loadRun(runDir), ctx)
    : { status: 'rejected', errors: [`no raw run folder at ${runDir} (is --raw pointing at the server's results root?)`], warnings: [] };
  return { runId: run.runId, serverStatus: state.status, abortReason, ...outcome };
}

// Cells that already have a valid run with this mode's label, so an
// interrupted session can resume without repeating finished cells.
export function completedCells(rawDir, ctx, mode) {
  const done = new Set();
  for (const dir of listRunDirs(rawDir)) {
    const loaded = loadRun(dir);
    if (loaded.run.clientLabel !== LABELS[mode]) continue;
    if (evaluateRun(loaded, ctx).status === 'valid') done.add(`${loaded.run.policyId}|${loaded.run.scenarioId}|${loaded.run.repetition}`);
  }
  return done;
}

export async function runSchedule(cells, deps) {
  const { ledgerFile, maxAttempts = 3, mode, log } = deps;
  const summary = { valid: 0, harnessInvalid: 0, rejected: 0, skipped: 0, attempts: 0 };
  const done = completedCells(deps.rawDir, deps.ctx, mode);
  for (const cell of cells) {
    const key = `${cell.policy}|${cell.trace}|${cell.repetition}`;
    const label = `#${cell.orderIndex ?? '-'} ${cell.trace} / ${cell.policy} / repeat ${cell.repetition}`;
    if (done.has(key)) {
      log(`${label}: already has a valid ${mode} run, skipping`);
      summary.skipped += 1;
      continue;
    }
    let previous = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      log(`${label}: attempt ${attempt}/${maxAttempts}`);
      summary.attempts += 1;
      const startedAt = new Date().toISOString();
      const result = await runAttempt(cell, deps);
      appendLedger(ledgerFile, {
        mode, ...cell, attempt, rerunOf: previous, runId: result.runId, startedAt, endedAt: new Date().toISOString(),
        serverStatus: result.serverStatus, abortReason: result.abortReason, validation: result.status, errors: result.errors, warnings: result.warnings,
      });
      log(`  → ${result.status}${result.errors.length ? `: ${result.errors[0]}` : ''}`);
      if (result.status === 'valid') { summary.valid += 1; break; }
      if (result.status === 'rejected') {
        summary.rejected += 1;
        // Untrustworthy evidence means a logging/apparatus bug. Rerunning
        // would only burn attempts, so stop for a human to investigate.
        throw new StopSession(`run ${result.runId} was rejected (${result.errors[0]}); fix the cause before continuing`);
      }
      summary.harnessInvalid += 1;
      previous = result.runId;
      if (attempt === maxAttempts) throw new StopSession(`${label}: ${maxAttempts} harness-invalid attempts in a row; investigate before continuing`);
    }
  }
  return summary;
}
