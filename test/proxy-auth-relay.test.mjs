/**
 * Unit tests for proxy-auth-relay.mjs — the loopback relay that supplies
 * Proxy-Authorization on Chromium's behalf. A fake upstream proxy stands in
 * for the real one, so these exercise the actual wire bytes (CONNECT line,
 * credential header, tunnel payload, 407 pass-through) without any network.
 * Run with `node --test test/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { parseProxyUrl, createAuthRelay, startAuthRelay } from '../proxy-auth-relay.mjs';

// ── parseProxyUrl ───────────────────────────────────────────────────

test('parseProxyUrl — splits credentials from the address', () => {
  const p = parseProxyUrl('http://fleet:s3cret@10.9.0.2:1082');
  assert.equal(p.host, '10.9.0.2');
  assert.equal(p.port, 1082);
  assert.equal(p.username, 'fleet');
  assert.equal(p.password, 's3cret');
  assert.equal(p.hasCredentials, true);
  assert.equal(p.proxyArg, 'http://10.9.0.2:1082');
});

test('parseProxyUrl — a credential-free URL is handed to Chromium untouched', () => {
  // The pre-relay behaviour, preserved exactly: --proxy-server accepts forms
  // this parser does not model, and breaking them would be a regression.
  for (const raw of ['http://vpn.internal:3128', 'socks5://gluetun:1080', 'proxy:8888']) {
    const p = parseProxyUrl(raw);
    assert.equal(p.hasCredentials, false, raw);
    assert.equal(p.proxyArg, raw, raw);
  }
});

test('parseProxyUrl — unparseable input passes through rather than crashing boot', () => {
  const p = parseProxyUrl('not a url');
  assert.equal(p.hasCredentials, false);
  assert.equal(p.proxyArg, 'not a url');
});

test('parseProxyUrl — an unparseable URL still gets its credentials masked', () => {
  // Caught live: a malformed URL is exactly when a password is most likely to
  // be in the string, and the passthrough branch was logging it verbatim.
  for (const raw of [
    'http://fleet:hunter2@host:notaport',
    'http://fleet:hunter2@:',
    'fleet:hunter2@host 8080',
  ]) {
    const p = parseProxyUrl(raw);
    assert.equal(p.hasCredentials, false, raw);
    assert.ok(!p.redacted.includes('hunter2'), `password leaked in redacted: ${p.redacted}`);
    assert.ok(p.redacted.includes('***'), `not masked: ${p.redacted}`);
  }
});

test('parseProxyUrl — defaults the port when the URL omits it', () => {
  assert.equal(parseProxyUrl('http://user:pass@proxy.example').port, 80);
});

test('parseProxyUrl — percent-encoded password survives round-trip', () => {
  // A password containing @ or : would otherwise split the authority wrongly.
  const p = parseProxyUrl('http://user:p%40ss%3Aword@host:8080');
  assert.equal(p.password, 'p@ss:word');
});

test('parseProxyUrl — redacted form never contains the password', () => {
  const p = parseProxyUrl('http://fleet:hunter2@10.9.0.2:1082');
  assert.ok(!p.redacted.includes('hunter2'), `leaked: ${p.redacted}`);
  assert.ok(!p.proxyArg.includes('hunter2'), `leaked: ${p.proxyArg}`);
  assert.equal(p.redacted, 'http://fleet:***@10.9.0.2:1082');
});

test('parseProxyUrl — rejects credentials the relay cannot actually serve', () => {
  // TLS to the proxy itself, and SOCKS, are both protocols the relay does not
  // speak. Fail loudly at startup instead of silently at first navigation.
  assert.throws(() => parseProxyUrl('https://u:p@host:443'), /not supported/);
  assert.throws(() => parseProxyUrl('socks5://u:p@host:1080'), /not supported/);
});

// ── fake upstream proxy ─────────────────────────────────────────────

/**
 * server.close() only stops new connections; established ones — especially
 * CONNECT-upgraded sockets, which Node detaches from the server's own
 * bookkeeping — keep the event loop alive. Without this the suite passes and
 * then sits for two minutes before exiting.
 */
function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return () => {
    for (const s of sockets) s.destroy();
    sockets.clear();
    server.close();
  };
}

/**
 * Minimal HTTP proxy that records what it was sent. `expectedCredential` makes
 * it answer 407 unless exactly that credential arrives.
 */
function startFakeUpstream({ expectedCredential = null } = {}) {
  const seen = {
    connectAuth: [], requestAuth: [], requestHeaders: [],
    connectTargets: [], tunnelPayload: [],
  };

  const server = http.createServer((req, res) => {
    seen.requestAuth.push(req.headers['proxy-authorization'] ?? null);
    seen.requestHeaders.push(req.headers);
    if (expectedCredential && req.headers['proxy-authorization'] !== expectedCredential) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="fake"' });
      res.end('denied');
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-upstream-path': req.url,
      // Per-hop headers the relay must not pass on to the client. The value is
      // deliberately distinctive: Node emits a `Keep-Alive` of its own for the
      // relay's hop, so only a marker proves which one the client received.
      connection: 'keep-alive',
      'keep-alive': 'timeout=99, max=upstreamhop',
    });
    res.end('forwarded');
  });

  server.on('connect', (req, socket, head) => {
    seen.connectAuth.push(req.headers['proxy-authorization'] ?? null);
    seen.connectTargets.push(req.url);
    if (expectedCredential && req.headers['proxy-authorization'] !== expectedCredential) {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="fake"\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    // Echo whatever comes down the tunnel so the test can prove bytes flow
    // both directions, including any bytes that rode along with the CONNECT.
    if (head && head.length) seen.tunnelPayload.push(head.toString());
    socket.on('data', (chunk) => {
      seen.tunnelPayload.push(chunk.toString());
      socket.write(`echo:${chunk.toString()}`);
    });
  });

  const stop = trackSockets(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen, stop });
    });
  });
}

const CREDENTIAL = `Basic ${Buffer.from('fleet:s3cret').toString('base64')}`;

async function withRelay(upstreamOpts, fn) {
  const upstream = await startFakeUpstream(upstreamOpts);
  const relay = await startAuthRelay({
    host: '127.0.0.1',
    port: upstream.port,
    username: 'fleet',
    password: 's3cret',
  });
  const stopRelay = trackSockets(relay.server);
  try {
    return await fn({ upstream, relay });
  } finally {
    stopRelay();
    upstream.stop();
  }
}

/** Open a CONNECT tunnel through the relay; resolves with status + socket. */
function connectThroughRelay(relayPort, target, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(relayPort, '127.0.0.1', () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.slice(0, end);
      const body = buffer.slice(end + 4);
      resolve({ status: Number(head.split(' ')[1]), head, body, socket });
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('timeout')); });
  });
}

// ── relay behaviour ─────────────────────────────────────────────────

test('relay — CONNECT reaches upstream carrying Proxy-Authorization', async () => {
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ upstream, relay }) => {
    const res = await connectThroughRelay(relay.port, 'example.com:443');
    assert.equal(res.status, 200, res.head);
    assert.equal(upstream.seen.connectAuth[0], CREDENTIAL);
    assert.equal(upstream.seen.connectTargets[0], 'example.com:443');
    res.socket.destroy();
  });
});

test('relay — the client sent no credential of its own', async () => {
  // The whole point: Chromium speaks to an open loopback proxy and never
  // sees the password.
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ relay }) => {
    const res = await connectThroughRelay(relay.port, 'example.com:443');
    assert.equal(res.status, 200);
    res.socket.destroy();
  });
});

test('relay — tunnel carries bytes in both directions', async () => {
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ relay }) => {
    const res = await connectThroughRelay(relay.port, 'example.com:443');
    assert.equal(res.status, 200);
    const echoed = await new Promise((resolve, reject) => {
      res.socket.once('data', (chunk) => resolve(chunk.toString()));
      res.socket.once('error', reject);
      res.socket.write('hello-tls');
    });
    assert.equal(echoed, 'echo:hello-tls');
    res.socket.destroy();
  });
});

test('relay — bytes sent before the tunnel opens are not dropped', async () => {
  // Chromium writes the TLS ClientHello immediately after CONNECT; if the
  // relay discards that `head` buffer the handshake stalls with no error.
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ upstream, relay }) => {
    const res = await connectThroughRelay(relay.port, 'example.com:443', 'early-clienthello');
    assert.equal(res.status, 200);
    const echoed = res.body || await new Promise((resolve, reject) => {
      res.socket.once('data', (chunk) => resolve(chunk.toString()));
      res.socket.once('error', reject);
    });
    assert.ok(echoed.includes('early-clienthello'), `head bytes lost: ${echoed}`);
    assert.ok(upstream.seen.tunnelPayload.join('').includes('early-clienthello'));
    res.socket.destroy();
  });
});

test('relay — a bad credential surfaces upstream 407 rather than a generic 502', async () => {
  const upstream = await startFakeUpstream({ expectedCredential: CREDENTIAL });
  const relay = await startAuthRelay({
    host: '127.0.0.1', port: upstream.port, username: 'fleet', password: 'wrong',
  });
  const stopRelay = trackSockets(relay.server);
  try {
    const res = await connectThroughRelay(relay.port, 'example.com:443');
    assert.equal(res.status, 407, res.head);
    assert.match(res.head, /proxy-authenticate/i);
    res.socket.destroy();
  } finally {
    stopRelay();
    upstream.stop();
  }
});

test('relay — an unreachable upstream answers 502, not a hung socket', async () => {
  // Bind then immediately release a port so the connect is refused.
  const probe = net.createServer();
  const deadPort = await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
  const relay = await startAuthRelay({
    host: '127.0.0.1', port: deadPort, username: 'fleet', password: 's3cret',
  });
  const stopRelay = trackSockets(relay.server);
  try {
    const res = await connectThroughRelay(relay.port, 'example.com:443');
    assert.equal(res.status, 502, res.head);
    res.socket.destroy();
  } finally {
    stopRelay();
  }
});

test('relay — plain http requests are forwarded with the credential', async () => {
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ upstream, relay }) => {
    const body = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: relay.port, method: 'GET',
        path: 'http://example.com/thing', // absolute-form, as a proxy client sends
        headers: { host: 'example.com' },
        agent: false, // the global agent keeps sockets alive past the test
      }, (res) => {
        let out = '';
        res.on('data', (c) => { out += c; });
        res.on('end', () => resolve({ status: res.statusCode, out, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(body.status, 200);
    assert.equal(body.out, 'forwarded');
    // The absolute-form target must survive the hop unchanged.
    assert.equal(body.headers['x-upstream-path'], 'http://example.com/thing');
    assert.equal(upstream.seen.requestAuth[0], CREDENTIAL);
  });
});

test('relay — per-hop headers are stripped in both directions', async () => {
  // A proxy that forwards `transfer-encoding` describes an encoding the bytes
  // no longer carry (Node already decoded them), and forwarding `connection`
  // lets one hop dictate the other's socket lifetime.
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ upstream, relay }) => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: relay.port, method: 'GET',
        path: 'http://example.com/thing',
        headers: {
          host: 'example.com',
          connection: 'keep-alive',
          'proxy-connection': 'keep-alive',
          te: 'trailers',
          'x-keep-me': 'yes',
        },
        agent: false,
      }, (r) => { r.resume(); r.on('end', () => resolve(r)); });
      req.on('error', reject);
      req.end();
    });

    const sentUp = upstream.seen.requestHeaders[0];
    assert.equal(sentUp['proxy-connection'], undefined, 'proxy-connection reached upstream');
    assert.equal(sentUp.te, undefined, 'te reached upstream');
    assert.equal(sentUp['x-keep-me'], 'yes', 'an ordinary header was dropped');

    // Node writes its own Keep-Alive for the relay-to-client hop; what must not
    // appear is the upstream's.
    assert.ok(
      !String(res.headers['keep-alive'] ?? '').includes('upstreamhop'),
      `upstream keep-alive reached the client: ${res.headers['keep-alive']}`,
    );
    assert.equal(res.headers['x-upstream-path'], 'http://example.com/thing');
  });
});

test('relay — the client cannot override the injected credential', async () => {
  // A page-supplied Proxy-Authorization must not reach upstream in place of ours.
  await withRelay({ expectedCredential: CREDENTIAL }, async ({ upstream, relay }) => {
    await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: relay.port, method: 'GET',
        path: 'http://example.com/thing',
        headers: { host: 'example.com', 'proxy-authorization': 'Basic bogus' },
        agent: false,
      }, (res) => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(upstream.seen.requestAuth[0], CREDENTIAL);
  });
});

test('relay — binds loopback only', async () => {
  const relay = await startAuthRelay({
    host: '127.0.0.1', port: 1, username: 'fleet', password: 's3cret',
  });
  try {
    // It holds live credentials and authenticates nobody, so a non-loopback
    // bind would hand the upstream proxy to anything on the container network.
    assert.equal(relay.server.address().address, '127.0.0.1');
  } finally {
    relay.server.close();
  }
});

test('createAuthRelay — the password never appears in relay log output', async () => {
  const lines = [];
  const server = createAuthRelay({
    host: '127.0.0.1', port: 1, username: 'fleet', password: 'hunter2',
    log: (m) => lines.push(m),
  });
  const stop = trackSockets(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const res = await connectThroughRelay(port, 'example.com:443');
    assert.equal(res.status, 502);
    assert.ok(lines.length > 0, 'the failure was logged');
    for (const line of lines) {
      assert.ok(!line.includes('hunter2'), `password leaked into log: ${line}`);
    }
    res.socket.destroy();
  } finally {
    stop();
  }
});
