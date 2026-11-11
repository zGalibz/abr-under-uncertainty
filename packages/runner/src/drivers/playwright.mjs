// Real-browser driver: opens Susmoy's player page in Chrome via Playwright.
//
// One browser process per runner session; one fresh browser context (new
// profile: no cookies, no cache, no storage) per run, as
// experiment.execution.freshBrowserContextPerRun requires. HTTP cache is
// disabled through the Chrome DevTools Protocol and service workers are
// blocked, matching experiment.browser.cacheEnabled / serviceWorkersBypassed.

import fs from 'node:fs';
import { chromium } from 'playwright-core';

export function createPlaywrightDriver({ executablePath, headless, viewport, deviceScaleFactor }) {
  let browser = null;
  return {
    name: 'playwright',

    async start() {
      if (!fs.existsSync(executablePath)) throw new Error(`Chrome not found at ${executablePath} (set --chrome or CHROME_PATH)`);
      browser = await chromium.launch({ executablePath, headless, args: ['--autoplay-policy=no-user-gesture-required'] });
      return { browserVersion: browser.version() };
    },

    async openSession({ url }) {
      const context = await browser.newContext({ viewport, deviceScaleFactor, serviceWorkers: 'block' });
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
      session.close = async () => { await context.close().catch(() => {}); };
      return session;
    },

    async stop() {
      await browser?.close().catch(() => {});
    },
  };
}
