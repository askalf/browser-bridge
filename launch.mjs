/**
 * browser-bridge launcher — stealth Chromium + socat-fronted CDP.
 *
 * Steps in order:
 *   1. Configure puppeteer-extra's stealth plugin with the full evasion
 *      set so navigator.webdriver, navigator.plugins, navigator.languages,
 *      WebGL vendor strings, etc. all look like a real Chrome session.
 *   2. Spawn socat to forward 0.0.0.0:9222 -> 127.0.0.1:9223. Recent
 *      Chromium versions bind --remote-debugging-port to localhost
 *      regardless of --remote-debugging-address. socat is the simplest
 *      portable workaround.
 *   3. puppeteer.launch(...) on port 9223 with realistic args.
 *   4. Heartbeat log every 60s so log scrapers can confirm liveness.
 *   5. SIGTERM/SIGINT teardown.
 *
 * Env:
 *   PUPPETEER_EXECUTABLE_PATH  — Chromium binary path. Default
 *                                 /usr/bin/chromium (Debian).
 *   HTTPS_PROXY / HTTP_PROXY    — passed as --proxy-server when set.
 *                                 Used for VPN-fronted scraping.
 */

import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const stealth = StealthPlugin();
// Enable every evasion the plugin ships with. The default set is partial
// to avoid surprising users; for an automation bridge we want them all.
const ALL_EVASIONS = [
  'chrome.app',
  'chrome.csi',
  'chrome.loadTimes',
  'chrome.runtime',
  'defaultArgs',
  'iframe.contentWindow',
  'media.codecs',
  'navigator.hardwareConcurrency',
  'navigator.languages',
  'navigator.permissions',
  'navigator.plugins',
  'navigator.vendor',
  'navigator.webdriver',
  'sourceurl',
  'user-agent-override',
  'webgl.vendor',
  'window.outerdimensions',
];
for (const e of ALL_EVASIONS) stealth.enabledEvasions.add(e);
puppeteer.use(stealth);

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium';
const INTERNAL_PORT = 9223; // chromium binds here (127.0.0.1)
const EXTERNAL_PORT = 9222; // socat exposes this on 0.0.0.0

const socat = spawn('socat', [
  `TCP-LISTEN:${EXTERNAL_PORT},fork,reuseaddr,bind=0.0.0.0`,
  `TCP:127.0.0.1:${INTERNAL_PORT}`,
], { stdio: 'inherit' });

socat.on('error', (err) => {
  console.error('[browser-bridge] socat failed:', err.message);
});

const args = [
  // Sandboxing is disabled because we run as a non-root user inside a
  // container; Linux unprivileged user namespaces are the broader
  // sandbox the host provides.
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  `--remote-debugging-port=${INTERNAL_PORT}`,
  '--remote-allow-origins=*',
  '--user-data-dir=/home/browser/data',
  // Realistic-fingerprint args: missing any one of these is a bot tell.
  '--window-size=1920,1080',
  '--lang=en-US,en',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--enable-webgl',
  '--enable-accelerated-2d-canvas',
  '--font-render-hinting=medium',
];

const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxy) {
  args.push(`--proxy-server=${proxy}`);
  console.log(`[browser-bridge] routing through proxy: ${proxy}`);
}

console.log('[browser-bridge] launching stealth Chromium...');

let browser;
try {
  browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args,
    // Drop --enable-automation so navigator.webdriver isn't trivially
    // truthy — this is one of the highest-signal bot detectors.
    ignoreDefaultArgs: ['--enable-automation'],
  });

  console.log('[browser-bridge] stealth Chromium running');
  console.log(`[browser-bridge] CDP (internal): ws://127.0.0.1:${INTERNAL_PORT}/...`);
  console.log(`[browser-bridge] CDP (external): ws://0.0.0.0:${EXTERNAL_PORT}/... (via socat)`);
} catch (err) {
  console.error('[browser-bridge] failed to launch:', err.message);
  socat.kill();
  process.exit(1);
}

const shutdown = async (signal) => {
  console.log(`[browser-bridge] ${signal} received, shutting down...`);
  try {
    await browser.close();
  } catch (err) {
    console.error('[browser-bridge] error closing browser:', err.message);
  }
  socat.kill();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Heartbeat — periodically check the browser is still connected.
// If it crashed or detached, exit so the container restarts.
setInterval(async () => {
  try {
    const pages = await browser.pages();
    console.log(`[browser-bridge] alive — ${pages.length} page(s) open`);
  } catch {
    console.error('[browser-bridge] browser disconnected, exiting');
    process.exit(1);
  }
}, 60_000).unref();
