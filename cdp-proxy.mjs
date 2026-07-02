/**
 * CDP front proxy — the HTTP-aware layer that fronts Chromium's
 * loopback-bound DevTools endpoint on the container's external port.
 *
 * Replaces the old socat TCP relay so the bridge can do things a dumb
 * byte-pipe can't:
 *
 *   1. Optional token auth (BRIDGE_TOKEN). When a token is configured,
 *      every HTTP request and WebSocket upgrade must carry it — via
 *      `Authorization: Bearer <token>`, an `X-Bridge-Token` header, or
 *      a `?token=` query parameter (the browserless-style connection
 *      string). Comparison is timing-safe. The token is stripped before
 *      anything is forwarded to Chromium.
 *
 *   2. Connect by hostname. Chromium rejects DNS names in the Host
 *      header ("Host header is specified and is not an IP address or
 *      localhost"), which is why clients have historically had to dig
 *      up the container's IP. The proxy always presents a loopback Host
 *      to Chromium and rewrites the JSON discovery responses
 *      (webSocketDebuggerUrl etc.) back to whatever host the client
 *      used — so `connectOverCDP('http://browser:9222')` works with a
 *      compose service name. Chromium's Host check doubled as DNS-
 *      rebinding protection, so hostname Hosts are only accepted when
 *      token auth is on (auth defeats rebinding) or the operator
 *      explicitly opts in with BRIDGE_ALLOW_HOSTNAMES=1. IP-literal and
 *      localhost Hosts behave exactly as before.
 *
 *   3. Root-path WebSocket resolution. Chromium's browser target lives
 *      at an unguessable /devtools/browser/<uuid> path that normally
 *      requires an HTTP round-trip to discover. An upgrade to `/` is
 *      resolved to the current browser target server-side, so
 *      `puppeteer.connect({ browserWSEndpoint: 'ws://host:9222/?token=…' })`
 *      is a one-liner.
 *
 * After the 101 handshake the proxy is a transparent byte-pipe — zero
 * per-message overhead on the CDP hot path.
 */

import http from 'node:http';
import net from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * @param {object} opts
 * @param {number} opts.internalPort   Chromium's loopback CDP port.
 * @param {number} opts.externalPort   Port clients connect to (used only
 *                                     as the rewrite fallback when a
 *                                     request has no Host header).
 * @param {string} [opts.token]        Shared secret; empty = no auth.
 * @param {boolean} [opts.allowHostnames]  Accept DNS-name Host headers
 *                                     without a token (rebinding trade-off).
 * @param {(event: string, detail?: object) => void} [opts.onEvent]
 *                                     'auth-failure' | 'host-blocked' |
 *                                     'ws-open' | 'ws-close'
 * @param {(msg: string) => void} [opts.log]
 * @returns {http.Server}
 */
export function createCdpProxy({
  internalPort,
  externalPort,
  token = '',
  allowHostnames = false,
  onEvent = () => {},
  log = () => {},
}) {
  const internalHost = `127.0.0.1:${internalPort}`;
  const tokenDigest = token ? createHash('sha256').update(token).digest() : null;

  const tokenMatches = (candidate) => {
    if (!tokenDigest || typeof candidate !== 'string' || candidate.length === 0) return false;
    return timingSafeEqual(createHash('sha256').update(candidate).digest(), tokenDigest);
  };

  const presentedToken = (req, url) => {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
    const header = req.headers['x-bridge-token'];
    if (typeof header === 'string') return header;
    return url.searchParams.get('token');
  };

  const hostIsIpOrLocalhost = (hostHeader) => {
    if (!hostHeader) return true; // HTTP/1.0-style; forwarded as loopback anyway
    let hostname;
    try {
      hostname = new URL(`http://${hostHeader}`).hostname;
    } catch {
      return false;
    }
    const bare = hostname.replace(/^\[|\]$/g, '');
    return net.isIP(bare) !== 0 || bare.toLowerCase() === 'localhost';
  };

  /** @returns {{ok: true} | {ok: false, status: number, message: string, event: string}} */
  const authorize = (req, url) => {
    if (tokenDigest && !tokenMatches(presentedToken(req, url))) {
      return {
        ok: false, status: 401, event: 'auth-failure',
        message: 'browser-bridge: missing or invalid token (Authorization: Bearer, X-Bridge-Token, or ?token=)',
      };
    }
    if (!tokenDigest && !allowHostnames && !hostIsIpOrLocalhost(req.headers.host)) {
      return {
        ok: false, status: 403, event: 'host-blocked',
        message: 'browser-bridge: hostname Host headers require BRIDGE_TOKEN auth (or BRIDGE_ALLOW_HOSTNAMES=1). Connect via IP/localhost, or enable one of those.',
      };
    }
    return { ok: true };
  };

  // Rebuild the forwarded header block from rawHeaders so casing and
  // ordering survive; swap Host for Chromium's loopback and drop our
  // auth headers (Chromium has no use for them).
  const forwardedHeaderLines = (req) => {
    const lines = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower === 'authorization' || lower === 'x-bridge-token') continue;
      lines.push(`${name}: ${lower === 'host' ? internalHost : req.rawHeaders[i + 1]}`);
    }
    return lines;
  };

  const strippedPath = (url) => {
    url.searchParams.delete('token');
    const qs = url.searchParams.toString();
    return url.pathname + (qs ? `?${qs}` : '');
  };

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://bridge.invalid');
    } catch {
      res.writeHead(400).end();
      return;
    }
    const verdict = authorize(req, url);
    if (!verdict.ok) {
      onEvent(verdict.event);
      res.writeHead(verdict.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: verdict.message }));
      return;
    }

    const headers = {};
    for (const line of forwardedHeaderLines(req)) {
      const idx = line.indexOf(': ');
      headers[line.slice(0, idx)] = line.slice(idx + 2);
    }
    const upstreamReq = http.request(
      { host: '127.0.0.1', port: internalPort, method: req.method, path: strippedPath(url), headers },
      (upstreamRes) => {
        const chunks = [];
        upstreamRes.on('data', (c) => chunks.push(c));
        upstreamRes.on('end', () => {
          let body = Buffer.concat(chunks);
          // Chromium generates webSocketDebuggerUrl / devtoolsFrontendUrl
          // from the Host we presented (loopback:internalPort). Point them
          // back at whatever host:port the client actually used.
          const type = upstreamRes.headers['content-type'] || '';
          if (body.length && /json|text/i.test(type)) {
            const externalHost = req.headers.host || `127.0.0.1:${externalPort}`;
            body = Buffer.from(body.toString('utf8').replaceAll(internalHost, externalHost));
          }
          const outHeaders = { ...upstreamRes.headers, 'content-length': body.length };
          delete outHeaders['transfer-encoding'];
          res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
          res.end(body);
        });
        upstreamRes.on('error', () => res.destroy());
      },
    );
    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `browser-bridge: CDP upstream unreachable (${err.message})` }));
      } else {
        res.destroy();
      }
    });
    req.pipe(upstreamReq);
  });

  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let url;
    try {
      url = new URL(req.url, 'http://bridge.invalid');
    } catch {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    const verdict = authorize(req, url);
    if (!verdict.ok) {
      onEvent(verdict.event);
      const statusLine = verdict.status === 401 ? '401 Unauthorized' : '403 Forbidden';
      socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }

    let path = strippedPath(url);
    if (url.pathname === '/' || url.pathname === '') {
      // Resolve the browser target so clients can skip the discovery
      // round-trip and connect straight to ws://host:externalPort/.
      try {
        const version = await fetchJson(`http://${internalHost}/json/version`);
        path = new URL(version.webSocketDebuggerUrl).pathname;
      } catch (err) {
        log(`root-path resolve failed: ${err.message}`);
        socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        return;
      }
      if (socket.destroyed) return; // client gave up while we resolved
    }

    const upstream = net.connect(internalPort, '127.0.0.1');
    let opened = false;
    upstream.on('connect', () => {
      opened = true;
      onEvent('ws-open', { path });
      upstream.write(
        `${req.method} ${path} HTTP/1.1\r\n${forwardedHeaderLines(req).join('\r\n')}\r\n\r\n`,
      );
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    upstream.on('close', () => {
      socket.destroy();
      if (opened) onEvent('ws-close', { path });
    });
    socket.on('close', () => upstream.destroy());
  });

  return server;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(4000, () => req.destroy(new Error('timeout')));
  });
}
