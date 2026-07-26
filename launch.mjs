/**
 * browser-bridge launcher — stealth Chromium + proxy-fronted CDP.
 *
 * Two session models, chosen by BRIDGE_SESSION_MODE:
 *
 *   shared   (default) — one Chromium; every CDP client connects to the same
 *              browser target. Lowest memory; but a client's browser.close()
 *              or target enumeration reaches every other client's pages. The
 *              idle reaper reclaims tabs leaked by clients that die.
 *
 *   isolated — a session broker gives each connection its OWN stealth Chromium
 *              (see session-broker.mjs). Hard isolation: no client sees or
 *              closes another's targets, and browser.close() only kills that
 *              client's session. Named ?session= sessions are reused across
 *              reconnects; keyless connections are ephemeral. Higher memory /
 *              per-session launch latency, capped by BRIDGE_MAX_SESSIONS.
 *
 * Both modes front CDP with the same cdp-proxy (token auth, hostname connect,
 * root-path resolve) and serve /healthz + /metrics on the internal health port.
 *
 * Env (shared with both modes unless noted):
 *   BRIDGE_SESSION_MODE         — 'shared' (default) | 'isolated'.
 *   BRIDGE_MAX_SESSIONS         — isolated: concurrent-session cap. Default 20.
 *   BRIDGE_SESSION_IDLE_MS      — isolated: reap a session this long after its
 *                                 last connection closes. Default 300000 (5m).
 *   PUPPETEER_EXECUTABLE_PATH   — Chromium binary. Default /usr/bin/chromium.
 *   HTTPS_PROXY / HTTP_PROXY    — passed as --proxy-server when set (VPN).
 *   CDP_ALLOWED_ORIGIN          — allowed CDP websocket Origin values.
 *   BRIDGE_TOKEN                — shared secret; when set every CDP request /
 *                                 WebSocket must present it.
 *   BRIDGE_ALLOW_HOSTNAMES      — accept DNS-name Host headers without a token.
 *   BRIDGE_HEALTH_PORT          — health/metrics port. Default 9224.
 *   BRIDGE_REAP_INTERVAL_MS     — reaper cadence. Default 30000.
 *   BRIDGE_BLANK_TTL_MS         — shared: idle about:blank tab TTL. Default 120000.
 *   BRIDGE_MAX_IDLE_MS          — shared: reap any page idle this long. Default
 *                                 900000 (15m), measured from last navigation.
 *   BRIDGE_MAX_PAGES            — shared: hard page-count cap. Default 25.
 *   BROWSER_SESSION_ID          — caller-supplied UA seed (shared mode; in
 *                                 isolated mode the per-session key seeds the UA).
 */

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { createCdpProxy } from './cdp-proxy.mjs';
import { createSessionBroker } from './session-broker.mjs';
import { detectChromeMajor, buildUaPool, pickUa } from './ua.mjs';
import { buildLaunchOptions } from './launch-opts.mjs';
import { clearStaleSingletonLock } from './profile-lock.mjs';

// Rotating UA pool — picked deterministically per session so a given session
// keeps a stable fingerprint across reconnects. The Chrome major is derived
// from the ACTUAL installed Chromium (see ua.mjs), never hardcoded, so the
// advertised version can't drift from the browser that renders the page — a
// UA-vs-engine mismatch is itself a bot tell.
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH ?? '/usr/bin/chromium';
const CHROME_MAJOR = detectChromeMajor(CHROME_PATH);
const UA_POOL = buildUaPool(CHROME_MAJOR);
const FALLBACK_SEED = `${process.pid}:${Date.now()}`;

const SESSION_ID = process.env.BROWSER_SESSION_ID ?? '';
const USER_AGENT = pickUa(UA_POOL, SESSION_ID, FALLBACK_SEED);

const stealth = StealthPlugin();
// Enable every evasion the plugin ships with. Registered once on the shared
// puppeteer-extra singleton; it hooks the browser's targetcreated, so evasions
// apply to every page — including ones external CDP clients open (verified).
const ALL_EVASIONS = [
  'chrome.app', 'chrome.csi', 'chrome.loadTimes', 'chrome.runtime', 'defaultArgs',
  'iframe.contentWindow', 'media.codecs', 'navigator.hardwareConcurrency',
  'navigator.languages', 'navigator.permissions', 'navigator.plugins',
  'navigator.vendor', 'navigator.webdriver', 'sourceurl', 'user-agent-override',
  'webgl.vendor', 'window.outerdimensions',
];
for (const e of ALL_EVASIONS) stealth.enabledEvasions.add(e);
puppeteer.use(stealth);

// Shared-mode profile. The image creates and chowns this for the `browser`
// user; mount a volume here to persist it. Passed as puppeteer's
// `userDataDir` option, never as an arg — see launch-opts.mjs.
const SHARED_USER_DATA_DIR = process.env.BRIDGE_USER_DATA_DIR ?? '/home/browser/data';

const INTERNAL_PORT = 9223; // shared mode: chromium binds here (127.0.0.1)
const EXTERNAL_PORT = 9222; // the CDP proxy exposes this on 0.0.0.0

const SESSION_MODE = (process.env.BRIDGE_SESSION_MODE ?? 'shared').toLowerCase();
const ISOLATED = SESSION_MODE === 'isolated';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN ?? '';
const ALLOW_HOSTNAMES = !!process.env.BRIDGE_ALLOW_HOSTNAMES;
const MAX_SESSIONS = parseInt(process.env.BRIDGE_MAX_SESSIONS || '20', 10);
const SESSION_IDLE_MS = parseInt(process.env.BRIDGE_SESSION_IDLE_MS || '300000', 10);

// CDP origin lock — restrict the CDP WebSocket Origin to loopback so a
// browser-based page can't drive the CDP via DNS rebinding. Puppeteer /
// Playwright send no Origin header and are unaffected.
const DEFAULT_ALLOWED_ORIGINS = [
  `http://127.0.0.1:${INTERNAL_PORT}`, `http://localhost:${INTERNAL_PORT}`,
  `http://127.0.0.1:${EXTERNAL_PORT}`, `http://localhost:${EXTERNAL_PORT}`,
].join(',');
const ALLOWED_ORIGINS = process.env.CDP_ALLOWED_ORIGIN || DEFAULT_ALLOWED_ORIGINS;

const HEALTH_PORT = parseInt(process.env.BRIDGE_HEALTH_PORT || '9224', 10);
const REAP_INTERVAL_MS = parseInt(process.env.BRIDGE_REAP_INTERVAL_MS || '30000', 10);
const BLANK_TTL_MS = parseInt(process.env.BRIDGE_BLANK_TTL_MS || '120000', 10);
const MAX_IDLE_MS = parseInt(process.env.BRIDGE_MAX_IDLE_MS || '900000', 10);
const MAX_PAGES = parseInt(process.env.BRIDGE_MAX_PAGES || '25', 10);

// Chromium args common to both modes. Per-instance args (debugging port, user
// data dir, user-agent) are appended per launch below.
const COMMON_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-software-rasterizer',
  `--remote-allow-origins=${ALLOWED_ORIGINS}`,
  '--window-size=1920,1080', '--lang=en-US,en',
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
  '--enable-features=NetworkService,NetworkServiceInProcess',
  '--enable-webgl', '--enable-accelerated-2d-canvas', '--font-render-hinting=medium',
];
const HTTP_PROXY = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
if (HTTP_PROXY) {
  COMMON_ARGS.push(`--proxy-server=${HTTP_PROXY}`);
  console.log(`[browser-bridge] routing through proxy: ${HTTP_PROXY}`);
}

console.log(`[browser-bridge] session mode: ${ISOLATED ? 'isolated (process-per-session)' : 'shared'}`);
console.log(`[browser-bridge] CDP allowed origins: ${ALLOWED_ORIGINS}`);

// ── Shared metrics + proxy event wiring ─────────────────────────────
const metrics = {
  startedAt: Date.now(),
  navCount: 0, pagesCreated: 0, pagesReaped: 0, healthChecks: 0, lastReapAt: 0,
  authFailures: 0, hostBlocked: 0, cdpConnectionsTotal: 0, cdpConnectionsActive: 0,
  sessionsCreatedTotal: 0, sessionsRejected: 0,
};
const proxyOnEvent = (event) => {
  if (event === 'auth-failure') metrics.authFailures++;
  else if (event === 'host-blocked') metrics.hostBlocked++;
  else if (event === 'ws-open') { metrics.cdpConnectionsTotal++; metrics.cdpConnectionsActive++; }
  else if (event === 'ws-close') metrics.cdpConnectionsActive = Math.max(0, metrics.cdpConnectionsActive - 1);
};
const plog = (msg) => console.log(`[browser-bridge] cdp-proxy: ${msg}`);

// Filled in by whichever runtime we start. getHealth() returns { ok, pageCheck,
// pagesOpen }; snapshotMetrics() returns the mode-specific /metrics fields;
// reap()/heartbeat()/teardown() are the per-mode lifecycle hooks.
let cdpProxy;
let getHealth = async () => ({ ok: false, pageCheck: 'unknown', pagesOpen: 0 });
let snapshotMetrics = () => ({});
let reap = async () => {};
let heartbeat = async () => {};
let teardown = async () => {};

if (ISOLATED) {
  await startIsolated();
} else {
  await startShared();
}

// ── Common scaffolding (proxy listen, reaper, health/metrics, heartbeat) ──
cdpProxy.on('error', (err) => console.error('[browser-bridge] CDP proxy error:', err.message));
cdpProxy.listen(EXTERNAL_PORT, '0.0.0.0', () => {
  const authMode = BRIDGE_TOKEN
    ? 'token required'
    : `open${ALLOW_HOSTNAMES ? ', hostname Hosts allowed' : ''} (set BRIDGE_TOKEN to require auth)`;
  console.log(`[browser-bridge] CDP proxy on 0.0.0.0:${EXTERNAL_PORT} — auth: ${authMode}`);
});

const reaperTimer = setInterval(() => {
  reap().catch((e) => console.error('[browser-bridge] reaper error:', e?.message || e));
}, REAP_INTERVAL_MS);

const healthServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      uptimeSec: Math.round((Date.now() - metrics.startedAt) / 1000),
      mode: ISOLATED ? 'isolated' : 'shared',
      navCount: metrics.navCount,
      pagesReaped: metrics.pagesReaped,
      healthChecks: metrics.healthChecks,
      lastReapAt: metrics.lastReapAt,
      authFailures: metrics.authFailures,
      hostBlocked: metrics.hostBlocked,
      cdpConnectionsTotal: metrics.cdpConnectionsTotal,
      cdpConnectionsActive: metrics.cdpConnectionsActive,
      ...snapshotMetrics(),
    }));
    return;
  }
  metrics.healthChecks++;
  const h = await getHealth();
  res.writeHead(h.ok ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: h.ok, connected: h.ok, pageCheck: h.pageCheck, pagesOpen: h.pagesOpen }));
});
healthServer.on('error', (err) => console.error('[browser-bridge] health server error:', err.message));
healthServer.listen(HEALTH_PORT, '127.0.0.1', () => {
  console.log(`[browser-bridge] health/metrics on http://127.0.0.1:${HEALTH_PORT}/healthz (+ /metrics)`);
});

const shutdown = async (signal) => {
  console.log(`[browser-bridge] ${signal} received, shutting down...`);
  clearInterval(reaperTimer);
  try { healthServer.close(); } catch { /* already closed */ }
  try { cdpProxy.close(); } catch { /* already closed */ }
  try { await teardown(); } catch (err) { console.error('[browser-bridge] teardown error:', err.message); }
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Heartbeat every 60s so log scrapers can confirm liveness.
setInterval(() => { heartbeat().catch(() => {}); }, 60_000).unref();

// ════════════════════════════════════════════════════════════════════
// SHARED runtime — one Chromium, fronted directly by the proxy.
// ════════════════════════════════════════════════════════════════════
async function startShared() {
  const opts = buildLaunchOptions({
    chromePath: CHROME_PATH,
    commonArgs: COMMON_ARGS,
    debugPort: INTERNAL_PORT,
    userDataDir: SHARED_USER_DATA_DIR,
    userAgent: USER_AGENT,
  });
  console.log('[browser-bridge] launching stealth Chromium...');
  console.log(`[browser-bridge] Chromium major: ${CHROME_MAJOR} (UA pool tracks the real browser)`);
  console.log(`[browser-bridge] UA: ${USER_AGENT}`);
  console.log(`[browser-bridge] profile: ${SHARED_USER_DATA_DIR}`);

  // A profile on a volume outlives the container, and a container is killed
  // rather than shut down, so Chromium's singleton lock survives naming a
  // hostname that no longer exists and every later launch is refused. Clear it
  // before launching, not after a failure — the failure is fatal to startup.
  clearStaleSingletonLock(SHARED_USER_DATA_DIR, {
    log: (msg) => console.log(`[browser-bridge] ${msg}`),
  });

  let browser;
  try {
    browser = await puppeteer.launch(opts);
    console.log('[browser-bridge] stealth Chromium running');
    console.log(`[browser-bridge] CDP (external): ws://0.0.0.0:${EXTERNAL_PORT}/... (via cdp-proxy)`);
  } catch (err) {
    console.error('[browser-bridge] failed to launch:', err.message);
    process.exit(1);
  }

  // Target tracking — use the Target object as the map key (puppeteer emits
  // the same instance for created/changed/destroyed).
  const targets = new Map(); // Target -> { createdAt, lastActivity, url }
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
      rec.lastActivity = now;
      targets.set(t, rec);
      if (rec.url && rec.url !== 'about:blank') {
        metrics.navCount++;
        console.log(`[browser-bridge] nav -> ${rec.url}`);
      }
    } catch { /* target gone */ }
  });
  browser.on('targetdestroyed', (t) => { targets.delete(t); });

  cdpProxy = createCdpProxy({
    internalPort: INTERNAL_PORT, externalPort: EXTERNAL_PORT,
    token: BRIDGE_TOKEN, allowHostnames: ALLOW_HOSTNAMES,
    onEvent: proxyOnEvent, log: plog,
  });

  // Reaper — reclaim leaked / abandoned pages.
  reap = async () => {
    const now = Date.now();
    const idleOf = (page) => {
      try { const rec = targets.get(page.target()); if (rec) return now - (rec.lastActivity ?? rec.createdAt); } catch { /* no target */ }
      return 0;
    };
    const live = (await browser.pages()).filter((p) => !p.isClosed?.());
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
    const remaining = (await browser.pages()).filter((p) => !p.isClosed?.());
    if (remaining.length > MAX_PAGES) {
      const sorted = remaining.map((p) => ({ p, idle: idleOf(p) })).sort((a, b) => b.idle - a.idle);
      const excess = sorted.slice(0, remaining.length - MAX_PAGES);
      for (const { p } of excess) { await p.close().catch(() => {}); metrics.pagesReaped++; }
      console.log(`[browser-bridge] page cap ${MAX_PAGES} exceeded — reaped ${excess.length} most-idle`);
    }
    metrics.lastReapAt = now;
  };

  // Health — deep page-load check refreshed at most every 60s.
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
  getHealth = async () => {
    const connected = browser.connected;
    const now = Date.now();
    if (connected && now - healthCache.at > 60000) healthCache = { at: now, pageCheck: await runPageCheck() };
    return { ok: connected, pageCheck: connected ? healthCache.pageCheck : 'down', pagesOpen: targets.size };
  };

  snapshotMetrics = () => ({ pagesOpen: targets.size, pagesCreated: metrics.pagesCreated });

  heartbeat = async () => {
    try {
      await browser.pages();
      console.log(`[browser-bridge] alive — ${targets.size} page(s), ${metrics.navCount} nav, ${metrics.pagesReaped} reaped`);
    } catch {
      console.error('[browser-bridge] browser disconnected, exiting');
      process.exit(1);
    }
  };

  teardown = async () => { await browser.close(); };
}

// ════════════════════════════════════════════════════════════════════
// ISOLATED runtime — a broker gives each connection its own Chromium.
// ════════════════════════════════════════════════════════════════════
async function startIsolated() {
  const launch = async (key) => {
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sess-'));
    const b = await puppeteer.launch(buildLaunchOptions({
      chromePath: CHROME_PATH,
      commonArgs: COMMON_ARGS,
      debugPort: 0,
      userDataDir: udd,
      userAgent: pickUa(UA_POOL, key, FALLBACK_SEED),
    }));
    return {
      wsEndpoint: b.wsEndpoint(),
      pid: b.process()?.pid,
      close: async () => {
        try { await b.close(); } catch { /* already gone */ }
        try { fs.rmSync(udd, { recursive: true, force: true }); } catch { /* gone */ }
      },
    };
  };

  const broker = createSessionBroker({
    launch, maxSessions: MAX_SESSIONS, idleTtlMs: SESSION_IDLE_MS,
    onEvent: (event) => {
      if (event === 'session-created') metrics.sessionsCreatedTotal++;
      else if (event === 'session-rejected') metrics.sessionsRejected++;
    },
    log: (msg) => console.log(`[browser-bridge] broker: ${msg}`),
  });

  console.log(`[browser-bridge] session broker ready — max ${MAX_SESSIONS} sessions, idle TTL ${Math.round(SESSION_IDLE_MS / 1000)}s`);
  console.log(`[browser-bridge] CDP (external): ws://0.0.0.0:${EXTERNAL_PORT}/?session=<key> (via cdp-proxy)`);

  cdpProxy = createCdpProxy({
    externalPort: EXTERNAL_PORT, token: BRIDGE_TOKEN, allowHostnames: ALLOW_HOSTNAMES,
    broker, onEvent: proxyOnEvent, log: plog,
  });

  reap = async () => { await broker.reap(); metrics.lastReapAt = Date.now(); };

  // Health — a broker is healthy if it can still launch a browser. The probe
  // spins up a throwaway session, so refresh it slowly (5m) to bound cost.
  let healthCache = { at: 0, pageCheck: 'unknown' };
  getHealth = async () => {
    const now = Date.now();
    if (now - healthCache.at > 300000) healthCache = { at: now, pageCheck: await broker.probe() };
    const ok = healthCache.pageCheck !== 'degraded';
    return { ok, pageCheck: healthCache.pageCheck, pagesOpen: broker.stats().sessionsActive };
  };

  snapshotMetrics = () => {
    const s = broker.stats();
    return {
      sessionsActive: s.sessionsActive,
      sessionsReferenced: s.sessionsReferenced,
      sessionsCreatedTotal: s.sessionsCreatedTotal,
      sessionsRejected: metrics.sessionsRejected,
      maxSessions: s.maxSessions,
    };
  };

  heartbeat = async () => {
    const s = broker.stats();
    console.log(`[browser-bridge] alive — ${s.sessionsActive} session(s), ${s.sessionsCreatedTotal} created, ${metrics.pagesReaped} reaped`);
  };

  teardown = async () => { await broker.disposeAll(); };
}
