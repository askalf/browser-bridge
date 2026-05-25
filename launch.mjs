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
 *   BROWSER_SESSION_ID          — optional caller-supplied session ID.
 *                                 Same ID -> same UA; different IDs
 *                                 spread across the UA pool. Falls back
 *                                 to a per-process seed when unset.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

// Rotating UA pool — latest Chrome stable across the major desktop
// and mobile platforms. Picked deterministically per session so a
// given session keeps a stable fingerprint across reconnects, while
// different sessions spread across the pool to avoid one UA dominating
// a target's logs. Bump the Chrome major as new stable ships.
const UA_POOL = [
  // Windows 10
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  // macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  // Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  // Android (Pixel 8)
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36',
  // iOS (Chrome on iPhone reports as CriOS)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/132.0.0.0 Mobile/15E148 Safari/604.1',
];

// Per-process fallback seed — hashed once so we don't recompute on
// every pickUa() call. Used when no explicit session ID is supplied.
const FALLBACK_SEED = `${process.pid}:${Date.now()}`;

function pickUa(sessionId) {
  const seed = sessionId && sessionId.length > 0 ? sessionId : FALLBACK_SEED;
  const digest = createHash('sha256').update(seed).digest();
  // Read a 32-bit slice — plenty of entropy for a 5-item pool and
  // keeps the modulo bias far below anything observable.
  const idx = digest.readUInt32BE(0) % UA_POOL.length;
  return UA_POOL[idx];
}

const SESSION_ID = process.env.BROWSER_SESSION_ID ?? '';
const USER_AGENT = pickUa(SESSION_ID);

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
  `--user-agent=${USER_AGENT}`,
];

const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (proxy) {
  args.push(`--proxy-server=${proxy}`);
  console.log(`[browser-bridge] routing through proxy: ${proxy}`);
}

console.log('[browser-bridge] launching stealth Chromium...');
console.log(`[browser-bridge] UA: ${USER_AGENT}`);

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
