/**
 * SPIKE Q2 (v2) — does browser-bridge stealth reach EXTERNALLY-created pages,
 * and if so, is there an injection race on first load?
 *
 * v1 revealed: puppeteer-extra hooks the browser's `targetcreated`, so the
 * LAUNCHING instance DOES try to inject stealth evasions into pages that
 * external CDP clients create — but asynchronously (best-effort). This
 * version measures both the steady state and the race window.
 *
 * For each path we capture markers TWICE:
 *   t0  — immediately after page creation (may be pre-injection)
 *   tN  — after polling navigator.plugins.length to go nonzero (injection landed),
 *         recording how many ms that took.
 *
 * Marker navigator.plugins.length is the tell: real headless Chrome = 0,
 * stealth injects a fake plugin array (~5). If tN shows plugins>0 for the
 * external paths, stealth reaches them; the latency is the race window a
 * client's first navigation can slip through unprotected.
 */

import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import puppeteerCore from 'puppeteer-core';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Plugin injection into a page that a fast test then closes throws a
// harmless TargetCloseError from a detached async tick — count, don't crash.
let bestEffortRejections = 0;
process.on('unhandledRejection', (e) => {
  if (String(e?.message || e).includes('Session closed')) bestEffortRejections++;
  else console.error('UNEXPECTED rejection:', e);
});

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UDD = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-spike-'));

const stealth = StealthPlugin();
for (const e of [
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime', 'defaultArgs',
  'iframe.contentWindow', 'media.codecs', 'navigator.hardwareConcurrency',
  'navigator.languages', 'navigator.permissions', 'navigator.plugins',
  'navigator.vendor', 'navigator.webdriver', 'sourceurl', 'user-agent-override',
  'webgl.vendor', 'window.outerdimensions',
]) stealth.enabledEvasions.add(e);
puppeteerExtra.use(stealth);

const args = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-software-rasterizer', '--remote-debugging-port=0',
  `--user-data-dir=${UDD}`, '--window-size=1920,1080', '--lang=en-US,en',
  '--disable-blink-features=AutomationControlled',
  '--enable-webgl', '--enable-accelerated-2d-canvas', '--font-render-hinting=medium',
];

const PROBE = `(() => {
  let renderer = 'n/a';
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch {}
  return {
    webdriver: navigator.webdriver,
    plugins: navigator.plugins.length,
    chromeRuntime: !!(window.chrome && window.chrome.runtime),
    languages: JSON.stringify(navigator.languages),
    renderer: String(renderer).slice(0, 40),
  };
})()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll plugins.length until nonzero (stealth landed) or timeout. Returns
// {waitedMs, markers}. Evaluates in the live page each poll.
async function measure(evalFn) {
  const t0 = await evalFn(PROBE);
  const start = Date.now();
  let waited = 0;
  // up to 3s; plugins>0 means the navigator.plugins evasion injected + ran
  while (Date.now() - start < 3000) {
    const m = await evalFn(PROBE);
    if (m.plugins > 0) { waited = Date.now() - start; return { t0, tN: m, waitedMs: waited, landed: true }; }
    await sleep(50);
  }
  return { t0, tN: await evalFn(PROBE), waitedMs: 3000, landed: false };
}

const results = {};
const browser = await puppeteerExtra.launch({
  headless: true, executablePath: CHROME, args,
  ignoreDefaultArgs: ['--enable-automation'],
});
const wsEndpoint = browser.wsEndpoint();
const openPages = [];

// ── Path A: launching puppeteer-extra instance ──────────────────────
{
  const page = await browser.newPage();
  openPages.push(page);
  await page.goto('about:blank');
  results.A_launchInstance = await measure((expr) => page.evaluate(expr));
}

// ── Path B: fresh connectOverCDP vanilla puppeteer-core client ──────
const clientB = await puppeteerCore.connect({ browserWSEndpoint: wsEndpoint });
{
  const page = await clientB.newPage();
  openPages.push(page);
  await page.goto('about:blank');
  results.B_externalPuppeteer = await measure((expr) => page.evaluate(expr));
}

// ── Path C: raw CDP, Target.createTarget + attach (non-puppeteer) ────
const clientC = await puppeteerCore.connect({ browserWSEndpoint: wsEndpoint });
{
  try {
    const cdp = await clientC.target().createCDPSession();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const session = clientC._connection.session(sessionId);
    const evalFn = async (expr) => {
      const r = await session.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      return r.result.value;
    };
    results.C_rawCDP = await measure(evalFn);
    results.C_rawCDP._targetId = targetId;
  } catch (err) {
    results.C_rawCDP = { error: err.message };
  }
}

results._bestEffortRejections = bestEffortRejections;
console.log('=== RESULTS ===');
console.log(JSON.stringify(results, null, 2));

// Teardown — close pages first, swallow best-effort noise, then browser.
for (const p of openPages) { try { await p.close(); } catch {} }
try { await clientB.disconnect(); } catch {}
try { await clientC.disconnect(); } catch {}
await sleep(200);
try { await browser.close(); } catch {}
fs.rmSync(UDD, { recursive: true, force: true });
process.exit(0);
