// ════════════════════════════════════════════════════════════════════
// Authenticated upstream proxy support.
//
// Chromium cannot authenticate to a proxy from the command line. Credentials
// embedded in --proxy-server (http://user:pass@host) are parsed off and
// discarded, and there is no --proxy-auth flag; the browser expects to answer
// the 407 interactively. That leaves every authenticated proxy — which is to
// say every commercial residential/rotating proxy, and any VPN sidecar with
// auth switched on — unreachable from a headless container.
//
// The usual workaround is puppeteer's page.authenticate(), but that enables
// the CDP Fetch domain on each page. browser-bridge exists to be driven by
// EXTERNAL CDP clients, and a client calling setRequestInterception would then
// be fighting us for the same domain. Breaking request interception to gain
// proxy auth is a bad trade for this image specifically.
//
// So instead: a loopback relay. Chromium points at 127.0.0.1, unauthenticated;
// the relay adds Proxy-Authorization and forwards upstream. Chromium's network
// stack is untouched, no CDP domain is claimed, and external clients keep full
// use of Fetch and Network.
//
// The relay binds loopback only. It is deliberately an open proxy — anything
// that can reach it can use the upstream credentials — so it must never be
// exposed beyond the container.
//
// ── Failover ────────────────────────────────────────────────────────
//
// With `fallback: 'direct'` the relay stops being a hard dependency on the
// upstream. When the upstream proxy is UNREACHABLE the request is retried
// straight out of the container instead of failing.
//
// Two things this deliberately does NOT do:
//
//   - It does not fall back on a 407, or on any answer the upstream actually
//     sends. Wrong credentials, a blocked port, a refused CONNECT — those are
//     the upstream working and saying no, and papering over them would turn a
//     config error into a silent egress change. Only a failure to *reach* it
//     counts.
//   - It does not fail open by default. `fallback` is off unless asked for,
//     because for the residential-egress case the whole point of the proxy is
//     the exit address: going direct means the same browser, carrying the same
//     logged-in cookies, suddenly appearing from the datacenter. For some
//     workloads that is worse than an outage, so it is the caller's call.
//
// Unreachable includes the silent case. A tunnel whose far end has gone away
// often does not refuse connections, it black-holes them — so there is an
// explicit connect timeout, without which a dead tunnel hangs every navigation
// until Chromium gives up rather than failing over.
// ════════════════════════════════════════════════════════════════════

import http from 'node:http';
import net from 'node:net';

// How long to wait for the upstream proxy to accept a TCP connection before
// treating it as unreachable. Only covers connection setup: once a tunnel is
// established the timer is cleared, so long-lived CDP/WebSocket streams are
// never cut by it.
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

// After a failure, skip the upstream entirely for this long. Without it every
// single request pays the connect timeout while the tunnel is down, which
// turns a working fallback into a browser that loads pages 8s late.
const DEFAULT_BREAKER_COOLDOWN_MS = 30000;

// Failures that mean "could not reach the proxy" as opposed to "the proxy
// answered". ECONNRESET is in here only for the pre-response window — after a
// tunnel is established a reset is a real remote close and is passed through.
const UNREACHABLE = new Set([
  'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN',
  'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

function isUnreachable(err) {
  return Boolean(err) && (UNREACHABLE.has(err.code) || err.code === undefined);
}

// Mask a `user:pass@` authority in a string that may not be a valid URL.
// Anything between `//` (or the start) and the last `@` is treated as
// credentials, since that is how the authority is delimited regardless of
// whether the rest of the URL parses.
function redactAuthority(value) {
  return value.replace(/(^|\/\/)([^/@]*):([^/@]*)@/, (_m, lead, user) => `${lead}${user}:***@`);
}

/**
 * Split a CONNECT target into host and port.
 *
 * IPv6 literals arrive bracketed (`[::1]:443`) and a bare `rsplit(':')` would
 * cut them in the middle of the address.
 *
 * @param {string} target
 * @returns {{host: string, port: number}}
 */
export function splitHostPort(target) {
  const value = String(target).trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2] || 443) };
  const idx = value.lastIndexOf(':');
  if (idx === -1) return { host: value, port: 443 };
  const port = Number(value.slice(idx + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { host: value.slice(0, idx), port: 443 };
  }
  return { host: value.slice(0, idx), port };
}

/**
 * Split a proxy URL into its parts, separating credentials from the address.
 *
 * Deliberately lenient about everything EXCEPT credentials. Chromium's
 * --proxy-server takes forms this does not model — bare `host:port`,
 * `socks5://…`, per-scheme rule lists — and those worked before the relay
 * existed. Anything without credentials is therefore handed to Chromium
 * exactly as the operator wrote it, and only a credentialed URL has to be
 * something the relay can actually serve.
 *
 * @param {string} raw  e.g. http://user:pass@10.0.0.2:1082
 * @returns {{host: string, port: number, username: string, password: string,
 *            hasCredentials: boolean, proxyArg: string, redacted: string}}
 */
export function parseProxyUrl(raw) {
  const value = String(raw).trim();
  const passthrough = {
    host: '', port: 0, username: '', password: '',
    hasCredentials: false,
    proxyArg: value,
    // Blunt-instrument redaction for the branch where the URL did NOT parse.
    // A malformed URL is exactly when a password is most likely to be sitting
    // in the string — a bad port, a stray character — and printing the raw
    // value there would leak it to the logs at the first sign of trouble.
    redacted: redactAuthority(value),
  };

  // A bare host:port is valid for --proxy-server but not for URL.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;

  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return passthrough;
  }
  if (!url.hostname) return passthrough;

  // URL percent-encodes credentials, so a password containing @ or : survives.
  const username = decodeURIComponent(url.username || '');
  const password = decodeURIComponent(url.password || '');
  const hasCredentials = Boolean(username || password);
  if (!hasCredentials) return passthrough;

  if (url.protocol !== 'http:') {
    // An https proxy means TLS to the proxy itself and a SOCKS proxy means a
    // different protocol entirely; the relay speaks neither. Fail at startup
    // rather than at the first navigation, where it would look like a network
    // fault rather than a configuration one.
    throw new Error(
      `credentials in a ${url.protocol}// proxy URL are not supported `
      + '— the auth relay speaks plain http to the upstream proxy',
    );
  }

  const port = url.port ? Number(url.port) : 80;
  return {
    host: url.hostname,
    port,
    username,
    password,
    hasCredentials: true,
    // Credential-free address, for the (unused here) case of pointing a client
    // straight at the upstream.
    proxyArg: `${url.protocol}//${url.hostname}:${port}`,
    // Safe to log. The password never reaches stdout, container logs, or a
    // crash report — logs are the most common way a proxy credential leaks.
    redacted: `${url.protocol}//${username}:***@${url.hostname}:${port}`,
  };
}

function credentialHeader(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

// Headers that describe a single hop and must not be forwarded to the next one
// (RFC 9110 §7.6.1). `transfer-encoding` is the one that bites: Node has already
// decoded a chunked body by the time we see it, so passing the header along
// would tell the client to expect an encoding the bytes no longer carry.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

// Copy a header bag, dropping the per-hop entries. Built on a null-prototype
// object so a header literally named `__proto__` or `constructor` is data
// rather than a prototype write.
function forwardableHeaders(headers) {
  const out = Object.create(null);
  for (const name of Object.keys(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) out[name] = headers[name];
  }
  return out;
}

// Read up to the end of the upstream's response head, then hand back the head
// and whatever body bytes arrived with it.
function readResponseHead(socket, onHead, onFail) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const end = buffer.indexOf('\r\n\r\n');
    if (end === -1) {
      // A proxy that never terminates its head would otherwise buffer forever.
      if (buffer.length > 32768) {
        socket.removeListener('data', onData);
        onFail(new Error('upstream response head exceeded 32KB'));
      }
      return;
    }
    socket.removeListener('data', onData);
    onHead(buffer.subarray(0, end).toString('latin1'), buffer.subarray(end + 4));
  };
  socket.on('data', onData);
}

/**
 * Trip-and-cooldown breaker around the upstream.
 *
 * Deliberately dumb: one failure opens it. A proxy that just refused a
 * connection is not going to be healthy for the next request microseconds
 * later, and a "3 strikes" counter would only mean three stalled navigations
 * before the fallback engages.
 */
function createBreaker({ cooldownMs, log, onEvent }) {
  let openUntil = 0;
  return {
    get isOpen() { return Date.now() < openUntil; },
    trip(reason) {
      const wasOpen = Date.now() < openUntil;
      openUntil = Date.now() + cooldownMs;
      if (!wasOpen) {
        log(`upstream unreachable (${reason}) — egressing DIRECT for the next ${Math.round(cooldownMs / 1000)}s`);
        onEvent('fallback-open');
      }
    },
    // Called after a request succeeds through the upstream. Closing early
    // matters: the cooldown is a backstop, not a minimum outage.
    close() {
      if (openUntil) {
        openUntil = 0;
        log('upstream reachable again — egressing through the proxy');
        onEvent('fallback-close');
      }
    },
  };
}

/**
 * Build the loopback relay. Call listen() on the returned server.
 *
 * @param {object} o
 * @param {string} o.host      upstream proxy host
 * @param {number} o.port      upstream proxy port
 * @param {string} o.username
 * @param {string} o.password
 * @param {'off'|'direct'} [o.fallback]  what to do when the upstream is
 *        unreachable. 'off' (default) returns 502 as before; 'direct' retries
 *        the request straight out of the container.
 * @param {number} [o.connectTimeoutMs]
 * @param {number} [o.breakerCooldownMs]
 * @param {(msg: string) => void} [o.log]
 * @param {(event: string) => void} [o.onEvent]
 * @returns {import('node:http').Server}
 */
export function createAuthRelay({
  host,
  port,
  username,
  password,
  fallback = 'off',
  connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  breakerCooldownMs = DEFAULT_BREAKER_COOLDOWN_MS,
  log = () => {},
  onEvent = () => {},
}) {
  const credential = credentialHeader(username, password);
  const failoverEnabled = fallback === 'direct';
  const breaker = createBreaker({ cooldownMs: breakerCooldownMs, log, onEvent });

  // ── plain HTTP (absolute-form) ────────────────────────────────────
  const forwardDirect = (req, res) => {
    onEvent('request-direct');
    let target;
    try {
      target = new URL(req.url);
    } catch {
      // Only reachable if Chromium sent a non-absolute request line, which it
      // does not do to a proxy. Nothing sensible to route it at.
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('malformed proxy request\n');
      return;
    }
    const direct = http.request({
      host: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: forwardableHeaders(req.headers),
    });
    direct.on('response', (dres) => {
      res.writeHead(dres.statusCode, forwardableHeaders(dres.headers));
      dres.pipe(res);
    });
    direct.on('error', (err) => {
      log(`direct request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('origin unreachable\n');
    });
    req.pipe(direct);
  };

  const server = http.createServer((req, res) => {
    if (failoverEnabled && breaker.isOpen) {
      forwardDirect(req, res);
      return;
    }

    // Chromium sends absolute-form requests for http:// URLs. Pass them
    // through unchanged apart from the credential.
    const upstream = http.request({
      host,
      port,
      method: req.method,
      path: req.url,
      headers: { ...forwardableHeaders(req.headers), 'proxy-authorization': credential },
      setHost: false,
    });

    // The request body is only piped once the TCP connection is up. Piping
    // eagerly would consume it, and a retry after an upstream failure would
    // then send the headers with no body behind them.
    let piped = false;
    let settled = false;
    const pipeBody = () => {
      if (piped) return;
      piped = true;
      req.pipe(upstream);
    };
    upstream.on('socket', (socket) => {
      if (!socket.connecting) {
        pipeBody();
        return;
      }
      socket.setTimeout(connectTimeoutMs, () => {
        if (!piped) socket.destroy(Object.assign(new Error('upstream connect timed out'), { code: 'ETIMEDOUT' }));
      });
      socket.once('connect', () => {
        socket.setTimeout(0);
        pipeBody();
      });
    });

    upstream.on('response', (upstreamRes) => {
      settled = true;
      breaker.close();
      // Header names here come from the origin server, which is remote and
      // untrusted — but relaying them is the entire job of a proxy, and this
      // one talks only to Chromium, the intended recipient. Node rejects
      // invalid header names and CR/LF in values, so response splitting isn't
      // reachable; what does need handling is the per-hop set, dropped above.
      res.writeHead(upstreamRes.statusCode, forwardableHeaders(upstreamRes.headers));
      upstreamRes.pipe(res);
    });
    upstream.on('error', (err) => {
      // Retry direct only while nothing has been sent and nothing consumed —
      // once the body is on the wire the request is no longer replayable.
      if (failoverEnabled && !settled && !piped && isUnreachable(err)) {
        breaker.trip(err.code || err.message);
        forwardDirect(req, res);
        return;
      }
      log(`upstream request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end('upstream proxy unreachable\n');
    });
  });

  // ── CONNECT (everything https, which is nearly everything) ────────
  const connectDirect = (req, clientSocket, head) => {
    onEvent('request-direct');
    const { host: targetHost, port: targetPort } = splitHostPort(req.url);
    const direct = net.connect(targetPort, targetHost, () => {
      direct.setTimeout(0);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) direct.write(head);
      direct.pipe(clientSocket);
      clientSocket.pipe(direct);
    });
    direct.setTimeout(connectTimeoutMs, () => direct.destroy(new Error('origin connect timed out')));
    direct.on('error', (err) => {
      log(`direct CONNECT ${req.url} failed: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      }
      direct.destroy();
    });
  };

  server.on('connect', (req, clientSocket, head) => {
    clientSocket.on('error', () => clientSocket.destroy());

    if (failoverEnabled && breaker.isOpen) {
      connectDirect(req, clientSocket, head);
      return;
    }

    let established = false;
    const upstream = net.connect(port, host, () => {
      upstream.write(
        `CONNECT ${req.url} HTTP/1.1\r\n`
        + `Host: ${req.url}\r\n`
        + `Proxy-Authorization: ${credential}\r\n`
        + 'Proxy-Connection: keep-alive\r\n\r\n',
      );
    });

    // Covers the black-hole case: a tunnel whose far end is gone accepts
    // nothing and refuses nothing. Cleared once the tunnel is up so a
    // long-lived stream is never cut by it.
    upstream.setTimeout(connectTimeoutMs, () => {
      if (!established) {
        upstream.destroy(Object.assign(new Error('upstream connect timed out'), { code: 'ETIMEDOUT' }));
      }
    });

    const fail = (err) => {
      if (failoverEnabled && !established && isUnreachable(err)) {
        breaker.trip(err.code || err.message);
        upstream.destroy();
        connectDirect(req, clientSocket, head);
        return;
      }
      log(`CONNECT ${req.url} failed: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end('HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\n\r\n');
      }
      upstream.destroy();
    };

    upstream.on('error', fail);

    readResponseHead(
      upstream,
      (responseHead, rest) => {
        const status = Number(responseHead.split(' ')[1]);
        if (status !== 200) {
          // Relay the upstream's own answer rather than inventing one — a 407
          // here means the credentials are wrong, and that should be legible
          // in the browser's error rather than flattened into a 502.
          //
          // Note this is NOT a failover case even with fallback on: the proxy
          // answered. Retrying direct here would silently swap the exit
          // address whenever the upstream started rejecting requests, which
          // is the one thing a residential route must never do quietly.
          log(`CONNECT ${req.url} refused upstream: ${responseHead.split('\r\n')[0]}`);
          clientSocket.end(`${responseHead}\r\n\r\n`);
          upstream.destroy();
          return;
        }

        established = true;
        upstream.setTimeout(0);
        breaker.close();

        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Bytes that arrived alongside the upstream head, and bytes Chromium
        // sent before the tunnel opened (the TLS ClientHello). Dropping either
        // stalls the handshake with no error to explain it.
        if (rest.length) clientSocket.write(rest);
        if (head && head.length) upstream.write(head);

        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      },
      fail,
    );
  });

  server.on('clientError', (_err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  // Read-only view for /healthz and /metrics, so a degraded egress is
  // observable from outside rather than only in the logs.
  server.egressStatus = () => (breaker.isOpen ? 'direct' : 'upstream');

  return server;
}

/**
 * Start the relay on an ephemeral loopback port.
 *
 * @returns {Promise<{server: import('node:http').Server, port: number, url: string,
 *                    egressStatus: () => 'upstream'|'direct'}>}
 */
export function startAuthRelay(options) {
  const server = createAuthRelay(options);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    // Port 0 — the kernel picks a free one. A fixed port would collide with
    // whatever else the image grows later, and nothing outside needs to guess it.
    server.listen(options.listenPort ?? 0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}`, egressStatus: server.egressStatus });
    });
  });
}
