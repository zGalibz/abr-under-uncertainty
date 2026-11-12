// Data-freeze manifest (TEAM_ROLES §6 C5, PROJECT_DESIGN §12 data-freeze gate).
//
//   node packages/analysis/src/freeze.mjs            write results/data-freeze.json
//   node packages/analysis/src/freeze.mjs --verify   re-hash everything and compare
//
// The manifest lists every file of every counted run (valid or not, so rerun
// lineage stays visible) with its SHA-256 and size, plus the hashes of the
// frozen apparatus, the run order, the runner ledger and the validation
// outcome. Raw folders are git-ignored, so this committed file is what proves
// later that the evidence behind the results was not changed.
//
// The file has no timestamp, so writing it twice from the same evidence gives
// identical bytes.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { COUNTED_LABELS } from './analyze.mjs';
import { loadContext } from './context.mjs';
import { evaluateRun } from './evaluate.mjs';
import { listRunDirs, loadRun, readJson, repoRoot, sha256File, writeJson } from './io.mjs';
import { validateMatrix } from './validate.mjs';

const rel = (p) => path.relative(repoRoot, p).split(path.sep).join('/');

function fileEntries(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return { name, bytes: fs.statSync(file).size, sha256: sha256File(file) };
    });
}

export function buildFreeze({ rawDir, orderFile, ledgerFile, labels = COUNTED_LABELS, ctx = loadContext() }) {
  const runs = [];
  for (const dir of listRunDirs(rawDir)) {
    const loaded = loadRun(dir);
    if (!labels.includes(loaded.run.clientLabel)) continue;
    const { status, errors } = evaluateRun(loaded, ctx);
    const { run } = loaded;
    runs.push({
      runId: run.runId,
      policyId: run.policyId,
      scenarioId: run.scenarioId,
      repetition: run.repetition,
      clientLabel: run.clientLabel,
      createdAt: run.createdAt,
      serverStatus: run.status,
      gitCommit: run.gitCommit,
      gitDirty: run.gitDirty,
      validation: status,
      errors,
      files: fileEntries(dir),
    });
  }
  runs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.runId.localeCompare(b.runId));
  const matrix = validateMatrix(runs.map((r) => ({ runId: r.runId, policyId: r.policyId, scenarioId: r.scenarioId, repetition: r.repetition, status: r.validation })), ctx);
  const hashIfPresent = (file) => (file && fs.existsSync(file) ? { path: rel(file), sha256: sha256File(file) } : null);
  return {
    schemaVersion: '1.0.0',
    experimentId: ctx.experiment.id,
    datasetVersion: 'v1',
    labels,
    apparatus: {
      experimentSha256: ctx.experimentSha256,
      packageSha256: ctx.packageSha256,
      scenarios: Object.fromEntries([...ctx.scenarios].map(([id, s]) => [id, s.computedSha256])),
    },
    runOrder: hashIfPresent(orderFile),
    runnerLedger: hashIfPresent(ledgerFile),
    counts: {
      runs: runs.length,
      valid: runs.filter((r) => r.validation === 'valid').length,
      harnessInvalid: runs.filter((r) => r.validation === 'harness_invalid').length,
      rejected: runs.filter((r) => r.validation === 'rejected').length,
      files: runs.reduce((n, r) => n + r.files.length, 0),
      bytes: runs.reduce((n, r) => n + r.files.reduce((m, f) => m + f.bytes, 0), 0),
    },
    matrix: { expected: matrix.expected, validCount: matrix.validCount, complete: matrix.errors.length === 0, errors: matrix.errors },
    runs,
  };
}

// Differences between a stored manifest and a fresh one, as readable lines.
export function diffFreeze(stored, fresh) {
  const problems = [];
  const freshRuns = new Map(fresh.runs.map((r) => [r.runId, r]));
  for (const r of stored.runs) {
    const now = freshRuns.get(r.runId);
    if (!now) { problems.push(`run ${r.runId} is missing`); continue; }
    const files = new Map(now.files.map((f) => [f.name, f]));
    for (const f of r.files) {
      const g = files.get(f.name);
      if (!g) problems.push(`${r.runId}/${f.name} is missing`);
      else if (g.sha256 !== f.sha256) problems.push(`${r.runId}/${f.name} changed (SHA-256 mismatch)`);
    }
    for (const g of now.files) if (!r.files.some((f) => f.name === g.name)) problems.push(`${r.runId}/${g.name} was added after the freeze`);
  }
  for (const r of fresh.runs) if (!stored.runs.some((s) => s.runId === r.runId)) problems.push(`run ${r.runId} was added after the freeze`);
  for (const key of ['runOrder', 'runnerLedger']) {
    if (stored[key]?.sha256 !== fresh[key]?.sha256) problems.push(`${stored[key]?.path ?? key} changed`);
  }
  if (JSON.stringify(stored.apparatus) !== JSON.stringify(fresh.apparatus)) problems.push('apparatus hashes changed');
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      raw: { type: 'string', default: 'results/raw' },
      order: { type: 'string', default: 'results/run-order.json' },
      ledger: { type: 'string', default: 'results/runner-ledger.ndjson' },
      out: { type: 'string', default: 'results/data-freeze.json' },
      verify: { type: 'boolean', default: false },
    },
  });
  const resolve = (p) => path.resolve(repoRoot, p);
  const fresh = buildFreeze({ rawDir: resolve(values.raw), orderFile: resolve(values.order), ledgerFile: resolve(values.ledger) });
  const out = resolve(values.out);
  if (values.verify) {
    if (!fs.existsSync(out)) throw new Error(`${values.out} does not exist; nothing to verify`);
    const problems = diffFreeze(readJson(out), fresh);
    if (problems.length) {
      console.error(`Data freeze BROKEN: ${problems.length} problem(s)`);
      for (const p of problems) console.error(`  ${p}`);
      process.exitCode = 1;
    } else {
      console.log(`Data freeze verified: ${fresh.counts.runs} run(s), ${fresh.counts.files} file(s), ${(fresh.counts.bytes / 1e6).toFixed(1)} MB unchanged`);
    }
  } else {
    writeJson(out, fresh);
    const c = fresh.counts;
    console.log(`Wrote ${values.out}: ${c.runs} run(s) (${c.valid} valid, ${c.harnessInvalid} harness-invalid, ${c.rejected} rejected), ${c.files} file(s), ${(c.bytes / 1e6).toFixed(1)} MB`);
    console.log(`Matrix: ${fresh.matrix.validCount}/${fresh.matrix.expected}${fresh.matrix.complete ? ' complete' : ` — ${fresh.matrix.errors.length} problem(s)`}`);
    if (!fresh.matrix.complete) process.exitCode = 1;
  }
}
