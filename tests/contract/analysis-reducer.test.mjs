// Checks the validator and reducer against hand-derived fixture expectations.
//   node --test tests/contract/

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { loadContext } from '../../packages/analysis/src/context.mjs';
import { evaluateRun } from '../../packages/analysis/src/evaluate.mjs';
import { listRunDirs, loadRun, readJson, repoRoot } from '../../packages/analysis/src/io.mjs';
import { FIXTURE_CONTEXT } from '../fixtures/analysis/build-fixtures.mjs';
import { median, percentile, sampleSd } from '../../packages/analysis/src/stats.mjs';
import { buildPairedDeltas } from '../../packages/analysis/src/summarize.mjs';

const casesDir = path.join(repoRoot, 'tests/fixtures/analysis/cases');
const cases = fs.readdirSync(casesDir).sort();
const ctx = loadContext(FIXTURE_CONTEXT);

for (const name of cases) {
  test(`fixture ${name}`, () => {
    const caseDir = path.join(casesDir, name);
    const expected = readJson(path.join(caseDir, 'expected.json'));
    const [runDir] = listRunDirs(caseDir);
    const got = evaluateRun(loadRun(runDir), ctx);
    assert.equal(got.status, expected.status, `status; errors: ${got.errors.join(' | ')}`);
    if (expected.errorIncludes) assert.ok(got.errors.some((e) => e.includes(expected.errorIncludes)), got.errors.join(' | '));
    if (expected.warningIncludes) assert.ok(got.warnings.some((w) => w.includes(expected.warningIncludes)), got.warnings.join(' | '));
    for (const [key, want] of Object.entries(expected.metrics ?? {})) {
      const have = got.reduced.metrics[key];
      if (typeof want === 'number') assert.ok(Math.abs(have - want) < 1e-6, `${key}: expected ${want}, got ${have}`);
      else assert.equal(have, want, key);
    }
    if (expected.anchorProactive) assert.equal(got.reduced.detail.reactions[0].proactive_or_already_safe, true);
  });
}

test('stats: median, sample SD, percentile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([null, 5]), 5);
  assert.ok(Math.abs(sampleSd([2, 4, 6]) - 2) < 1e-12);
  assert.equal(sampleSd([7]), null);
  assert.equal(percentile([0, 10], 0.05), 0.5);
});

test('paired deltas: positive improvement always means conservative did better', () => {
  const base = { trace_id: 't', repeat_id: 1 };
  const rows = buildPairedDeltas([
    { ...base, policy_id: 'default-hlsjs', rebuffer_duration_s: 4, tw_bitrate_kbps: 3000 },
    { ...base, policy_id: 'conservative-throughput-v1', rebuffer_duration_s: 1, tw_bitrate_kbps: 2500 },
  ]);
  const reb = rows.find((r) => r.metric === 'rebuffer_duration_s');
  const br = rows.find((r) => r.metric === 'tw_bitrate_kbps');
  assert.equal(reb.delta_c_minus_d, -3);
  assert.equal(reb.improvement_signed, 3); // fewer stalls = better
  assert.equal(br.delta_c_minus_d, -500);
  assert.equal(br.improvement_signed, -500); // lower bitrate = worse
});
