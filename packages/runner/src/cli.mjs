// Runner command line.
//
//   npm run runner -- --mode warmup  --player-url <url>   one discarded run per policy (stable trace)
//   npm run runner -- --mode dry-run --player-url <url>   one full run per policy (volatile trace by default)
//   npm run runner -- --mode counted --player-url <url>   the frozen 18-run matrix from results/run-order.json
//
// Options: --server (default http://127.0.0.1:8080), --raw (the server's
// results root, default results/raw), --driver playwright|stub,
// --chrome <path> (or CHROME_PATH), --headless, --trace <id> (dry-run),
// --limit <n> (counted: stop after n cells), --max-attempts <n>.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { loadContext } from '../../analysis/src/context.mjs';
import { repoRoot } from '../../analysis/src/io.mjs';
import { ServerApi } from './api.mjs';
import { createPlaywrightDriver } from './drivers/playwright.mjs';
import { createStubDriver } from './drivers/stub-player.mjs';
import { buildOrderDocument } from './order.mjs';
import { StopSession, runSchedule } from './runner.mjs';

export function gitState(cwd = repoRoot) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() !== '';
  return { commit, dirty };
}

function cellsFor(mode, ctx, { trace, orderFile }) {
  const policies = ctx.experiment.player.policies;
  if (mode === 'warmup') return policies.map((policy) => ({ policy, trace: 'stable-v1', repetition: 1 }));
  if (mode === 'dry-run') return policies.map((policy) => ({ policy, trace, repetition: 1 }));
  if (!fs.existsSync(orderFile)) throw new StopSession(`${path.relative(repoRoot, orderFile)} is missing; run "npm run runner:order" and commit it before counted runs`);
  const frozen = fs.readFileSync(orderFile, 'utf8');
  if (frozen !== `${JSON.stringify(buildOrderDocument(ctx), null, 2)}\n`) {
    throw new StopSession('results/run-order.json no longer matches the experiment config; the order must not change after it is frozen');
  }
  return JSON.parse(frozen).order;
}

async function main() {
  const { values } = parseArgs({
    options: {
      mode: { type: 'string' },
      server: { type: 'string', default: 'http://127.0.0.1:8080' },
      'player-url': { type: 'string' },
      raw: { type: 'string', default: 'results/raw' },
      driver: { type: 'string', default: 'playwright' },
      chrome: { type: 'string' },
      headless: { type: 'boolean', default: false },
      trace: { type: 'string', default: 'volatile-v1' },
      limit: { type: 'string' },
      'max-attempts': { type: 'string', default: '3' },
    },
  });
  const mode = values.mode;
  if (!['warmup', 'dry-run', 'counted'].includes(mode)) throw new StopSession('--mode must be warmup, dry-run or counted');
  const ctx = loadContext();
  const git = gitState();
  if (mode === 'counted' && git.dirty) throw new StopSession('counted runs require a clean git checkout (commit or stash your changes)');
  if (values.driver === 'stub' && mode === 'counted') throw new StopSession('the stub player can never produce counted runs');
  const playerUrl = values['player-url'] ?? (values.driver === 'stub' ? 'stub://player' : null);
  if (!playerUrl) throw new StopSession('--player-url is required (the URL of Susmoy\'s player page)');

  const api = new ServerApi(values.server);
  const ready = await api.ready().catch((e) => ({ status: `unreachable (${e.message})` }));
  if (ready.status !== 'ready') throw new StopSession(`server at ${values.server} is not ready: ${ready.status}. Start it with "npm run server" and make sure media/ is present.`);

  let cells = cellsFor(mode, ctx, { trace: values.trace, orderFile: path.join(repoRoot, 'results/run-order.json') });
  if (values.limit) cells = cells.slice(0, Number(values.limit));

  const b = ctx.experiment.browser;
  const driver = values.driver === 'stub'
    ? createStubDriver()
    : createPlaywrightDriver({
      executablePath: values.chrome ?? process.env.CHROME_PATH ?? b.executablePath,
      headless: values.headless || b.headless,
      viewport: b.viewport,
      deviceScaleFactor: b.deviceScaleFactor,
    });
  const { browserVersion } = await driver.start();
  console.log(`Runner: mode=${mode} driver=${driver.name} (${browserVersion}) git=${git.commit.slice(0, 8)}${git.dirty ? ' (dirty)' : ''} cells=${cells.length}`);
  try {
    const summary = await runSchedule(cells, {
      api, driver, ctx, mode, git, playerUrl,
      rawDir: path.resolve(repoRoot, values.raw),
      ledgerFile: path.join(repoRoot, 'results/runner-ledger.ndjson'),
      maxAttempts: Number(values['max-attempts']),
      log: console.log,
    });
    console.log(`Done: ${summary.valid} valid, ${summary.harnessInvalid} harness-invalid (rerun), ${summary.skipped} already done, ${summary.attempts} attempt(s)`);
  } finally {
    await driver.stop();
  }
}

main().catch((e) => {
  console.error(e instanceof StopSession ? `STOPPED: ${e.message}` : e);
  process.exitCode = 1;
});
