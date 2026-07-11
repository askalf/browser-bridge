/**
 * SPIKE Q1 — is context-per-connection isolation implementable over raw CDP?
 *
 * The broker plan: each client connection gets its own browser context;
 * the proxy filters Target.* so a client sees only its context's targets,
 * and disposing one context can't touch another. This probe validates the
 * CDP primitives that plan rests on:
 *
 *   1. Target.createBrowserContext yields independent contexts.
 *   2. Target.getTargets returns targets across ALL contexts, each tagged
 *      with browserContextId  → so filtering by context is both NECESSARY
 *      (clients see each other without it) and POSSIBLE (the tag is there).
 *   3. Target.disposeBrowserContext closes that context's pages only,
 *      leaving other contexts intact.
 *   4. A page created in a context carries that context's browserContextId,
 *      and Target.createTarget honours a browserContextId param.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

process.on('unhandledRejection', (e) => {
  if (!String(e?.message || e).includes('Session closed')) console.error('UNEXPECTED:', e);
});

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UDD = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-spike-'));
puppeteerExtra.use(StealthPlugin());

const browser = await puppeteerExtra.launch({
  headless: true, executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${UDD}`],
  ignoreDefaultArgs: ['--enable-automation'],
});

const cdp = await browser.target().createCDPSession();
const out = {};

// 1. two independent contexts
const { browserContextId: ctxA } = await cdp.send('Target.createBrowserContext', {});
const { browserContextId: ctxB } = await cdp.send('Target.createBrowserContext', {});
out.contextsDistinct = ctxA !== ctxB;

// 4. create a page in each, honouring browserContextId
const { targetId: pageA } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxA });
const { targetId: pageB } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: ctxB });

// 2. getTargets sees BOTH, each tagged with its context
const { targetInfos } = await cdp.send('Target.getTargets', {});
const tA = targetInfos.find((t) => t.targetId === pageA);
const tB = targetInfos.find((t) => t.targetId === pageB);
out.pageA_ctx = tA?.browserContextId;
out.pageB_ctx = tB?.browserContextId;
out.getTargets_seesBoth = !!tA && !!tB;
out.getTargets_tagsMatch = tA?.browserContextId === ctxA && tB?.browserContextId === ctxB;
// how many page targets a naive (unfiltered) client would enumerate:
out.pageTargetsVisibleUnfiltered = targetInfos.filter((t) => t.type === 'page').length;
// what a proxy filtering to ctxA would show:
out.pageTargetsVisibleFilteredToA = targetInfos.filter((t) => t.type === 'page' && t.browserContextId === ctxA).length;

// 3. dispose ctxA — its page dies, ctxB's survives
await cdp.send('Target.disposeBrowserContext', { browserContextId: ctxA });
const after = (await cdp.send('Target.getTargets', {})).targetInfos;
out.afterDisposeA_pageA_gone = !after.some((t) => t.targetId === pageA);
out.afterDisposeA_pageB_alive = after.some((t) => t.targetId === pageB);

// cleanup
await cdp.send('Target.disposeBrowserContext', { browserContextId: ctxB }).catch(() => {});

console.log('=== ISOLATION RESULTS ===');
console.log(JSON.stringify(out, null, 2));

await browser.close();
fs.rmSync(UDD, { recursive: true, force: true });
process.exit(0);
