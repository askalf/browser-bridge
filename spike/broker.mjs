/**
 * SPIKE — session broker, strategy (b): process-per-session routing.
 *
 * One external CDP port. Each client connection is routed to its OWN
 * stealth Chromium (launched via puppeteer-extra, so stealth is preserved),
 * so clients can't see or close each other's targets, and a client calling
 * browser.close() only kills its own session. No CDP frame parsing — after
 * the WS handshake this is still a transparent byte-pipe to the session's
 * browser, so the hot-path cost of the v0.2.0 proxy is unchanged.
 *
 * Session keying:
 *   - ws://host:PORT/?session=<key>  → named, reused across reconnects,
 *     survives disconnect (the long-lived-auth escape hatch).
 *   - ws://host:PORT/  (no key)      → ephemeral: a fresh browser minted
 *     for this connection, disposed when the socket closes.
 *   - GET /json/version              → mints an ephemeral id and returns a
 *     webSocketDebuggerUrl carrying it, so vanilla connectOverCDP (which
 *     does discovery-then-connect over two sockets) lands on one session.
 *     The browser is launched lazily on the WS, not the GET, so an
 *     abandoned discovery leaks nothing.
 *
 * Prototype only: no auth/reaper/metrics (those layer on unchanged from
 * v0.2.0); focus is proving the routing + isolation + stealth model.
 */

import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

puppeteerExtra.use(StealthPlugin());
const CHROME = process.env.BB_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const LAUNCH_ARGS = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
  '--disable-software-rasterizer', '--remote-debugging-port=0',
  '--window-size=1920,1080', '--lang=en-US,en',
  '--disable-blink-features=AutomationControlled',
  '--enable-webgl', '--enable-accelerated-2d-canvas', '--font-render-hinting=medium',
];

export function createBroker({ port = 0 } = {}) {
  /** @type {Map<string, {browser:any, internalPort:number, wsPath:string, ephemeral:boolean, sockets:Set<net.Socket>}>} */
  const sessions = new Map();
  const launches = []; // audit trail: every browser we spun up
  let seq = 0;
  const mintId = () => `eph-${++seq}-${createHash('sha1').update(String(seq)).digest('hex').slice(0, 8)}`;

  async function launchSession(key, ephemeral) {
    const udd = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-sess-'));
    const browser = await puppeteerExtra.launch({
      headless: true, executablePath: CHROME,
      args: [...LAUNCH_ARGS, `--user-data-dir=${udd}`],
      ignoreDefaultArgs: ['--enable-automation'],
    });
    const wsUrl = new URL(browser.wsEndpoint()); // ws://127.0.0.1:<p>/devtools/browser/<uuid>
    const rec = {
      browser, internalPort: Number(wsUrl.port), wsPath: wsUrl.pathname,
      ephemeral, sockets: new Set(), udd,
    };
    sessions.set(key, rec);
    launches.push({ key, pid: browser.process()?.pid, ephemeral });
    return rec;
  }

  async function getOrCreate(key, ephemeral) {
    return sessions.get(key) || (await launchSession(key, ephemeral));
  }

  async function dispose(key) {
    const rec = sessions.get(key);
    if (!rec) return;
    sessions.delete(key);
    try { await rec.browser.close(); } catch {}
    try { fs.rmSync(rec.udd, { recursive: true, force: true }); } catch {}
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://bridge.invalid');
    if (url.pathname.startsWith('/json/version')) {
      const sid = url.searchParams.get('session') || mintId();
      const host = req.headers.host || `127.0.0.1:${server.address().port}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        Browser: 'browser-bridge/broker',
        webSocketDebuggerUrl: `ws://${host}/?session=${sid}`,
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });

  server.on('upgrade', async (req, socket) => {
    socket.on('error', () => socket.destroy());
    const url = new URL(req.url, 'http://bridge.invalid');
    const named = url.searchParams.get('session');
    const key = named || mintId();
    const ephemeral = !named;
    let rec;
    try {
      rec = await getOrCreate(key, ephemeral);
    } catch (err) {
      socket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${err.message}`);
      return;
    }
    if (socket.destroyed) return;

    const upstream = net.connect(rec.internalPort, '127.0.0.1');
    rec.sockets.add(socket);
    upstream.on('connect', () => {
      // Rewrite the request line to the session browser's real target path;
      // strip our ?session param — Chromium never sees it.
      const lines = [`GET ${rec.wsPath} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const n = req.rawHeaders[i];
        lines.push(`${n}: ${n.toLowerCase() === 'host' ? `127.0.0.1:${rec.internalPort}` : req.rawHeaders[i + 1]}`);
      }
      upstream.write(lines.join('\r\n') + '\r\n\r\n');
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    const cleanup = () => {
      rec.sockets.delete(socket);
      upstream.destroy();
      // ephemeral session: last socket gone → tear the browser down.
      if (rec.ephemeral && rec.sockets.size === 0) dispose(key);
    };
    socket.on('close', cleanup);
    upstream.on('close', () => socket.destroy());
  });

  return {
    server,
    listen: () => new Promise((r) => server.listen(port, '127.0.0.1', () => r(server.address().port))),
    stats: () => ({ live: [...sessions.keys()], launches: [...launches] }),
    shutdownAll: async () => { for (const k of [...sessions.keys()]) await dispose(k); server.close(); },
  };
}
