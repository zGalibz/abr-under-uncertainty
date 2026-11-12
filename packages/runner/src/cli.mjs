// Runner command line.
//
//   npm run runner -- --mode warmup  --player-url <url>   one discarded run per policy (stable trace)
//   npm run runner -- --mode dry-run --player-url <url>   one full run per policy (volatile trace by default)
//   npm run runner -- --mode counted --player-url <url>   the frozen 18-run matrix from results/run-order.json
//   npm run runner -- --mode demo --record <dir> --player-url <url>
//                                                         one recorded run per policy (--trace), the demo fallback
//
// Options: --server (default http://127.0.0.1:8080), --raw (the server's
// results root, default results/raw), --driver playwright|stub,
// --chrome <path> (or CHROME_PATH), --headless, --trace <id> (dry-run),
// --limit <n> (counted: stop after n cells), --max-attempts <n>,
// --record <dir> (demo: save a .webm per run), --viewport WxH (demo only).

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

// The ledger is written by the runner itself during a session, so it does not
// make the checkout "dirty"; otherwise an interrupted counted session could
// never resume without a new commit (which would change the apparatus).
export const RUNNER_OWNED_PATHS = ['results/runner-ledger.ndjson'];

export function gitState(cwd = repoRoot) {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const excludes = RUNNER_OWNED_PATHS.map((p) => `:(exclude)${p}`);
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.', ...excludes], { cwd, encoding: 'utf8' }).trim() !== '';
  return { commit, dirty };
}

// The player bundle records the commit it was built from
// (apps/player/scripts/build.mjs writes build-metadata.js next to the page).
export async function readPlayerBuild(playerUrl) {
  const url = new URL('build-metadata.js', playerUrl);
  const res = await fetch(url).catch((e) => { throw new StopSession(`player page is unreachable at ${url} (${e.message}); start it with "npm run dev -w @abr-lab/player"`); });
  if (!res.ok) throw new StopSession(`could not read the player's build metadata at ${url} (HTTP ${res.status})`);
  const json = (await res.text()).match(/BUILD_METADATA = (\{.*\});/)?.[1];
  if (!json) throw new StopSession(`${url} does not contain BUILD_METADATA; rebuild the player`);
  return JSON.parse(json);
}

// Counted runs must use a player bundle built from exactly this clean
// checkout; otherwise the code under test might not be the committed code.
export function playerBuildProblem(build, git) {
  if (build.gitCommit !== git.commit) return `player bundle was built from ${String(build.gitCommit).slice(0, 8)}, but this checkout is ${git.commit.slice(0, 8)}`;
  if (build.gitDirty) return 'player bundle was built from a checkout with uncommitted changes';
  return null;
}

function cellsFor(mode, ctx, { trace, orderFile }) {
  const policies = ctx.experiment.player.policies;
  if (mode === 'warmup') return policies.map((policy) => ({ policy, trace: 'stable-v1', repetition: 1 }));
  if (mode === 'dry-run' || mode === 'demo') return policies.map((policy) => ({ policy, trace, repetition: 1 }));
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
      record: { type: 'string' },
      viewport: { type: 'string' },
    },
  });
  const mode = values.mode;
  if (!['warmup', 'dry-run', 'counted', 'demo'].includes(mode)) throw new StopSession('--mode must be warmup, dry-run, counted or demo');
  if (mode === 'demo' && !values.record) throw new StopSession('demo mode needs --record <dir> for the video files');
  if (mode !== 'demo' && (values.record || values.viewport)) throw new StopSession('--record and --viewport are only for demo mode (they would change the measured apparatus)');
  const ctx = loadContext();
  const git = gitState();
  if (mode === 'counted' && git.dirty) throw new StopSession('counted runs require a clean git checkout (commit or stash your changes)');
  if (values.driver === 'stub' && mode === 'counted') throw new StopSession('the stub player can never produce counted runs');
  const playerUrl = values['player-url'] ?? (values.driver === 'stub' ? 'stub://player' : null);
  if (!playerUrl) throw new StopSession('--player-url is required (the URL of Susmoy\'s player page)');

  let playerBuild = null;
  if (values.driver !== 'stub') {
    playerBuild = await readPlayerBuild(playerUrl);
    const problem = playerBuildProblem(playerBuild, git);
    if (problem && mode === 'counted') throw new StopSession(`${problem}; rebuild with "npm run build -w @abr-lab/player" from a clean checkout`);
    if (problem) console.warn(`WARNING: ${problem} (allowed for ${mode}, never for counted runs)`);
  }

  const api = new ServerApi(values.server);
  const ready = await api.ready().catch((e) => ({ status: `unreachable (${e.message})` }));
  if (ready.status !== 'ready') throw new StopSession(`server at ${values.server} is not ready: ${ready.status}. Start it with "npm run server" and make sure media/ is present.`);

  let cells = cellsFor(mode, ctx, { trace: values.trace, orderFile: path.join(repoRoot, 'results/run-order.json') });
  if (values.limit) cells = cells.slice(0, Number(values.limit));

  const b = ctx.experiment.browser;
  // Demo recordings use a taller window so the dashboard is in the video;
  // the player's ABR ignores the window size (capLevelToPlayerSize: false).
  const [vw, vh] = (values.viewport ?? (mode === 'demo' ? '1280x1300' : '')).split('x').map(Number);
  const recordVideoDir = mode === 'demo' ? path.resolve(repoRoot, values.record) : null;
  if (recordVideoDir) fs.mkdirSync(recordVideoDir, { recursive: true });
  const driver = values.driver === 'stub'
    ? createStubDriver()
    : createPlaywrightDriver({
      executablePath: values.chrome ?? process.env.CHROME_PATH ?? b.executablePath,
      headless: values.headless || b.headless,
      viewport: vw && vh ? { width: vw, height: vh } : b.viewport,
      deviceScaleFactor: b.deviceScaleFactor,
      recordVideoDir,
    });
  const { browserVersion } = await driver.start();
  const playerBuildCommit = playerBuild ? `${playerBuild.gitCommit}${playerBuild.gitDirty ? '-dirty' : ''}` : null;
  console.log(`Runner: mode=${mode} driver=${driver.name} (${browserVersion}) git=${git.commit.slice(0, 8)}${git.dirty ? ' (dirty)' : ''}${playerBuildCommit ? ` player=${playerBuildCommit.slice(0, 8)}` : ''} cells=${cells.length}`);
  try {
    const summary = await runSchedule(cells, {
      api, driver, ctx, mode, git, playerUrl,
      provenance: { driver: driver.name, browserVersion, playerBuildCommit },
      rawDir: path.resolve(repoRoot, values.raw),
      // Demo attempts never touch the counted ledger (its hash is in the data-freeze manifest).
      ledgerFile: recordVideoDir ? path.join(recordVideoDir, 'ledger.ndjson') : path.join(repoRoot, 'results/runner-ledger.ndjson'),
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
