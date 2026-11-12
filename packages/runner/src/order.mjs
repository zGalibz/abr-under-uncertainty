// Fixed, pre-registered run order (TEAM_ROLES C2). The order is derived only
// from the experiment config's orderSeed, written once to
// results/run-order.json and never changed after counted runs begin.
//
//   node packages/runner/src/order.mjs            # write (or verify) results/run-order.json

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { loadContext } from '../../analysis/src/context.mjs';
import { repoRoot } from '../../analysis/src/io.mjs';

// Small deterministic PRNG (mulberry32), so the shuffle is reproducible
// from the seed alone.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// Every policy × trace × repeat cell, Fisher–Yates shuffled by orderSeed.
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

export function experimentTraces(ctx) {
  return [...ctx.scenarios.values()].filter((s) => ctx.experiment.scenarioFiles.includes(s.path)).map((s) => s.id);
}

export function buildOrderDocument(ctx) {
  return {
    schemaVersion: '1.0.0',
    experimentId: ctx.experiment.id,
    experimentSha256: ctx.experimentSha256,
    orderSeed: ctx.experiment.execution.orderSeed,
    order: runOrder(ctx.experiment, experimentTraces(ctx)),
  };
}

// Writes the order file, or verifies an existing one is unchanged. An
// existing file that differs is never overwritten: that would be reordering.
export function writeOrFreezeOrder(file, ctx) {
  const doc = buildOrderDocument(ctx);
  const text = `${JSON.stringify(doc, null, 2)}\n`;
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') !== text) {
      throw new Error(`${file} exists and differs from the order derived from the current experiment config; refusing to overwrite`);
    }
    return { doc, written: false };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return { doc, written: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = path.join(repoRoot, 'results/run-order.json');
  const { doc, written } = writeOrFreezeOrder(file, loadContext());
  console.log(`${written ? 'Wrote' : 'Verified unchanged'} ${path.relative(repoRoot, file)} (${doc.order.length} runs, seed ${doc.orderSeed})`);
  for (const o of doc.order) console.log(`  ${String(o.orderIndex).padStart(2)}  ${o.trace.padEnd(12)} ${o.policy.padEnd(27)} repeat ${o.repetition}`);
}
