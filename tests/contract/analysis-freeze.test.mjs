// The data-freeze manifest must detect any change to frozen raw evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadContext } from '../../packages/analysis/src/context.mjs';
import { buildFreeze, diffFreeze } from '../../packages/analysis/src/freeze.mjs';
import { listRunDirs, repoRoot } from '../../packages/analysis/src/io.mjs';
import { FIXTURE_CONTEXT } from '../fixtures/analysis/build-fixtures.mjs';

const ctx = loadContext(FIXTURE_CONTEXT);
const casesDir = path.join(repoRoot, 'tests/fixtures/analysis/cases');

function rawCopy(t, caseNames) {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-test-'));
  t.after(() => fs.rmSync(raw, { recursive: true, force: true }));
  for (const name of caseNames) {
    const [runDir] = listRunDirs(path.join(casesDir, name));
    fs.cpSync(runDir, path.join(raw, path.basename(runDir)), { recursive: true });
  }
  return raw;
}

test('freeze manifest is deterministic and lists every file of every selected run', (t) => {
  const raw = rawCopy(t, ['clean_run', 'one_stall', 'invalid_user_pause']);
  const options = { rawDir: raw, orderFile: null, ledgerFile: null, labels: ['synthetic-fixture'], ctx };
  const first = buildFreeze(options);
  assert.deepEqual(buildFreeze(options), first);
  assert.equal(first.counts.runs, 3);
  assert.equal(first.counts.valid, 2);
  assert.equal(first.counts.harnessInvalid, 1);
  assert.ok(first.runs.every((r) => r.files.some((f) => f.name === 'events.ndjson' && /^[0-9a-f]{64}$/.test(f.sha256))));
  assert.deepEqual(buildFreeze({ ...options, labels: ['runner-counted'] }).runs, []);
});

test('verification reports edited, added and removed evidence', (t) => {
  const raw = rawCopy(t, ['clean_run', 'one_stall']);
  const options = { rawDir: raw, orderFile: null, ledgerFile: null, labels: ['synthetic-fixture'], ctx };
  const stored = buildFreeze(options);
  assert.deepEqual(diffFreeze(stored, buildFreeze(options)), []);

  const [first, second] = listRunDirs(raw);
  fs.appendFileSync(path.join(first, 'events.ndjson'), '\n');
  fs.writeFileSync(path.join(first, 'notes.txt'), 'added later');
  fs.rmSync(second, { recursive: true });
  const problems = diffFreeze(stored, buildFreeze(options));
  assert.ok(problems.some((p) => p.includes('events.ndjson changed')), problems.join(' | '));
  assert.ok(problems.some((p) => p.includes('notes.txt was added')), problems.join(' | '));
  assert.ok(problems.some((p) => p.includes(`${path.basename(second)} is missing`)), problems.join(' | '));
});
