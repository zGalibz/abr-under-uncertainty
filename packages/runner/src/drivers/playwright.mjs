// Real-browser driver: opens Susmoy's player page in Chrome via Playwright.
//
// One browser process per runner session; one fresh browser context (new
// profile: no cookies, no cache, no storage) per run, as
// experiment.execution.freshBrowserContextPerRun requires. HTTP cache is
// disabled through the Chrome DevTools Protocol and service workers are
// blocked, matching experiment.browser.cacheEnabled / serviceWorkersBypassed.

//
// recordVideoDir (demo mode only) records each page to
// <dir>/<runId>-<policyId>.webm, the prerecorded fallback for the live demo.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

export function createPlaywrightDriver({ executablePath, headless, viewport, deviceScaleFactor, recordVideoDir = null }) {
  let browser = null;
  return {
    name: 'playwright',

    async start() {
      if (!fs.existsSync(executablePath)) throw new Error(`Chrome not found at ${executablePath} (set --chrome or CHROME_PATH)`);
      browser = await chromium.launch({ executablePath, headless, args: ['--autoplay-policy=no-user-gesture-required'] });
      return { browserVersion: browser.version() };
    },

    async openSession({ url }) {
      const recordVideo = recordVideoDir ? { dir: recordVideoDir, size: viewport } : undefined;
      const context = await browser.newContext({ viewport, deviceScaleFactor, serviceWorkers: 'block', recordVideo });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      const session = { consoleLines: [], failure: null };
      const stamp = () => new Date().toISOString();
      page.on('console', (m) => session.consoleLines.push(`${stamp()} [${m.type()}] ${m.text()}`));
      page.on('pageerror', (e) => session.consoleLines.push(`${stamp()} [pageerror] ${e.message}`));
      page.on('crash', () => { session.failure = 'browser page crashed'; });
      page.on('close', () => { session.failure ??= 'player page was closed'; });
      await page.goto(url, { waitUntil: 'load' }).catch((e) => { session.failure = `could not load player page: ${e.message}`; });
      session.close = async () => {
        const video = page.video();
        await context.close().catch(() => {});
        if (video) {
          // The video file is complete once its context has closed. A failed
          // recording (e.g. Playwright's ffmpeg missing) never stops the session.
          const params = new URL(url).searchParams;
          const target = path.join(recordVideoDir, `${params.get('runId')}-${params.get('policyId')}.webm`);
          try {
            fs.renameSync(await video.path(), target);
            session.consoleLines.push(`${stamp()} [runner] page recorded to ${target}`);
          } catch (e) {
            session.consoleLines.push(`${stamp()} [runner] video NOT saved: ${e.message}`);
          }
        }
      };
      return session;
    },

    async stop() {
      await browser?.close().catch(() => {});
    },
  };
}
