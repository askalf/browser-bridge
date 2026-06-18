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
 *   4. Track page targets + navigations; reap orphaned/idle pages so a
 *      long-lived shared browser doesn't leak memory when clients die
 *      without closing their tabs.
 *   5. Serve /healthz + /metrics on 127.0.0.1:9224 (container-internal)
 *      so the Docker healthcheck sees CDP state, not just TCP liveness.
 *   6. Heartbeat log every 60s so log scrapers can confirm liveness.
 *   7. SIGTERM/SIGINT teardown.
 *
 * Env:
 *   PUPPETEER_EXECUTABLE_PATH  — Chromium binary path. Default
 *                                 /usr/bin/chromium (Debian).
 *   HTTPS_PROXY / HTTP_PROXY    — passed as --proxy-server when set.
 *                                 Used for VPN-fronted scraping.
 *   CDP_ALLOWED_ORIGIN          — comma-separated Origin header values
 *                                 allowed on CDP websocket connections.
 *                                 Default: loopback origins only (no '*').
 *   BRIDGE_HEALTH_PORT          — health/metrics port. Default 9224.
 *   BRIDGE_REAP_INTERVAL_MS     — reaper cadence. Default 30000.
 *   BRIDGE_BLANK_TTL_MS         — idle about:blank tab TTL. Default 120000.
 *   BRIDGE_MAX_IDLE_MS          — reap any page idle this long. Default
 *                                 900000 (15m). Idle is measured from last
 *                                 NAVIGATION, not creation, so long-lived
 *                                 reused pages reset their clock.
 *   BRIDGE_MAX_PAGES            — hard page-count cap; most-idle pages
 *                                 beyond it are reaped. Default 25.
 *   BROWSER_SESSION_ID          — optional caller-supplied session ID.
 *                                 Same ID -> same UA; different IDs
 *                                 spread across the UA pool. Falls back
 *                                 to a per-process seed when unset.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
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

// CDP origin lock: Chromium's --remote-allow-origins validates the Origin
// header on incoming DevTools/WebSocket connections. '*' lets ANY origin
// drive the CDP, which is a DNS-rebinding / cross-origin hijack risk.
// Restrict to the loopback origins legitimate puppeteer/playwright clients
// connect with (most CDP libraries send no Origin header at all and are
// unaffected). Override via CDP_ALLOWED_ORIGIN (comma-separated) if a
// client needs a different Origin header value.
const DEFAULT_ALLOWED_ORIGINS = [
  `http://127.0.0.1:${INTERNAL_PORT}`,
  `http://localhost:${INTERNAL_PORT}`,
  `http://127.0.0.1:${EXTERNAL_PORT}`,
  `http://localhost:${EXTERNAL_PORT}`,
].join(',');
const ALLOWED_ORIGINS = process.env.CDP_ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGINS;

// Reaper + health/metrics config. The browser is SHARED across clients:
// they connect over CDP, open pages, and sometimes die without closing
// them — orphaned tabs accumulate and leak memory on a long-lived
// browser. The reaper reclaims them.
const HEALTH_PORT = parseInt(process.env.BRIDGE_HEALTH_PORT || '9224', 10);
const REAP_INTERVAL_MS = parseInt(process.env.BRIDGE_REAP_INTERVAL_MS || '30000', 10);
const BLANK_TTL_MS = parseInt(process.env.BRIDGE_BLANK_TTL_MS || '120000', 10);
const MAX_IDLE_MS = parseInt(process.env.BRIDGE_MAX_IDLE_MS || '900000', 10);
const MAX_PAGES = parseInt(process.env.BRIDGE_MAX_PAGES || '25', 10);

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
  // No --disable-dev-shm-usage: run the container with --shm-size=512m
  // (or compose shm_size) so Chrome uses the fast /dev/shm. Setting the
  // flag forces page buffers to /tmp-on-disk — slower, and it can fill
  // the writable layer under load.
  '--disable-gpu',
  '--disable-software-rasterizer',
  `--remote-debugging-port=${INTERNAL_PORT}`,
  `--remote-allow-origins=${ALLOWED_ORIGINS}`,
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

console.log(`[browser-bridge] CDP allowed origins: ${ALLOWED_ORIGINS}`);
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

// ── Target tracking + activity logging ──────────────────────────────
// Use the Target object itself as the map key — puppeteer emits the same
// instance for created/changed/destroyed, so no private id juggling.
const targets = new Map(); // Target -> { createdAt, lastActivity, url }
const metrics = {
  startedAt: Date.now(),
  navCount: 0,
  pagesCreated: 0,
  pagesReaped: 0,
  healthChecks: 0,
  lastReapAt: 0,
};

browser.on('targetcreated', (t) => {
  try {
    if (t.type() !== 'page') return;
    const now = Date.now();
    targets.set(t, { createdAt: now, lastActivity: now, url: t.url() });
    metrics.pagesCreated++;
  } catch { /* target gone */ }
});
browser.on('targetchanged', (t) => {
  try {
    if (t.type() !== 'page') return;
    const now = Date.now();
    const rec = targets.get(t) || { createdAt: now };
    rec.url = t.url();
    rec.lastActivity = now; // navigation = activity -> resets the idle clock
    targets.set(t, rec);
    if (rec.url && rec.url !== 'about:blank') {
      metrics.navCount++;
      console.log(`[browser-bridge] nav -> ${rec.url}`);
    }
  } catch { /* target gone */ }
});
browser.on('targetdestroyed', (t) => { targets.delete(t); });

// ── Reaper: reclaim leaked / abandoned pages ────────────────────────
const reap = async () => {
  try {
    const now = Date.now();
    const idleOf = (page) => {
      try { const rec = targets.get(page.target()); if (rec) return now - (rec.lastActivity ?? rec.createdAt); } catch { /* no target */ }
      return 0; // unknown -> treat as just-active, don't reap
    };
    const live = (await browser.pages()).filter((p) => !p.isClosed?.());

    // 1) idle blank tabs + tabs idle past the cap
    for (const page of live) {
      const url = page.url();
      const idle = idleOf(page);
      const isBlank = !url || url === 'about:blank';
      if ((isBlank && idle > BLANK_TTL_MS) || (idle > MAX_IDLE_MS)) {
        await page.close().catch(() => {});
        metrics.pagesReaped++;
        console.log(`[browser-bridge] reaped page (idle=${Math.round(idle / 1000)}s, url=${url || 'about:blank'})`);
      }
    }

    // 2) hard count cap — close the most-idle beyond MAX_PAGES
    const remaining = (await browser.pages()).filter((p) => !p.isClosed?.());
    if (remaining.length > MAX_PAGES) {
      const sorted = remaining
        .map((p) => ({ p, idle: idleOf(p) }))
        .sort((a, b) => b.idle - a.idle); // most idle first
      const excess = sorted.slice(0, remaining.length - MAX_PAGES);
      for (const { p } of excess) { await p.close().catch(() => {}); metrics.pagesReaped++; }
      console.log(`[browser-bridge] page cap ${MAX_PAGES} exceeded — reaped ${excess.length} most-idle`);
    }

    metrics.lastReapAt = now;
  } catch (e) {
    console.error('[browser-bridge] reaper error:', e?.message || e);
  }
};
const reaperTimer = setInterval(reap, REAP_INTERVAL_MS);

// ── Health + metrics server (container-internal, 127.0.0.1 only) ────
// /healthz fails ONLY when the CDP connection is gone (container should
// restart); it also reports a deep page-load check (refreshed at most
// every 60s to avoid load) so a wedged-but-connected Chrome shows up as
// degraded.
let healthCache = { at: 0, pageCheck: 'unknown' };
const runPageCheck = async () => {
  let ctx;
  try {
    ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    const r = await Promise.race([
      p.evaluate(() => 1 + 1),
      new Promise((_, rej) => setTimeout(() => rej(new Error('eval timeout')), 4000)),
    ]);
    await ctx.close().catch(() => {});
    return r === 2 ? 'ok' : 'degraded';
  } catch {
    if (ctx) await ctx.close().catch(() => {});
    return 'degraded';
  }
};

const healthServer = http.createServer(async (req, res) => {
  const connected = browser.connected;
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      pagesOpen: targets.size,
      pagesCreated: metrics.pagesCreated,
      pagesReaped: metrics.pagesReaped,
      navCount: metrics.navCount,
      healthChecks: metrics.healthChecks,
      lastReapAt: metrics.lastReapAt,
      connected,
    }));
    return;
  }
  // /healthz (and any other path)
  metrics.healthChecks++;
  const now = Date.now();
  if (connected && now - healthCache.at > 60000) {
    healthCache = { at: now, pageCheck: await runPageCheck() };
  }
  const pageCheck = connected ? healthCache.pageCheck : 'down';
  res.writeHead(connected ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: connected, connected, pageCheck, pagesOpen: targets.size }));
});
healthServer.on('error', (err) => console.error('[browser-bridge] health server error:', err.message));
healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[browser-bridge] health/metrics on http://127.0.0.1:${HEALTH_PORT}/healthz (+ /metrics)`);
});

const shutdown = async (signal) => {
  console.log(`[browser-bridge] ${signal} received, shutting down...`);
  clearInterval(reaperTimer);
  try { healthServer.close(); } catch { /* already closed */ }
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
    await browser.pages();
    console.log(`[browser-bridge] alive — ${targets.size} page(s), ${metrics.navCount} nav, ${metrics.pagesReaped} reaped`);
  } catch {
    console.error('[browser-bridge] browser disconnected, exiting');
    process.exit(1);
  }
}, 60_000).unref();
