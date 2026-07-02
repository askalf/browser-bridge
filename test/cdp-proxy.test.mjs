/**
 * Unit tests for the CDP front proxy — run with `node --test test/`.
 *
 * A stub upstream stands in for Chromium's DevTools HTTP server: it
 * records what the proxy forwards (path, headers), serves /json/version
 * with a loopback webSocketDebuggerUrl the way Chromium does, and
 * completes WebSocket handshakes with a byte-echo so the transparent
 * pipe after the 101 can be asserted end-to-end. No Chromium, no deps.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { createCdpProxy } from '../cdp-proxy.mjs';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function listen(server, host = '127.0.0.1') {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

/** Stub Chromium DevTools endpoint. */
function makeUpstream() {
  const state = { lastRequest: null, lastUpgrade: null };
  const server = http.createServer((req, res) => {
    state.lastRequest = { method: req.method, path: req.url, headers: { ...req.headers } };
    if (req.url.startsWith('/json/version')) {
      const port = server.address().port;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify({
        Browser: 'Chrome/149.0.0.0',
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/stub-uuid-1234`,
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
  });
  server.on('upgrade', (req, socket) => {
    state.lastUpgrade = { path: req.url, headers: { ...req.headers } };
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.pipe(socket); // byte-echo: proves the proxy pipe is transparent
  });
  return { server, state };
}

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

/** Raw WebSocket-style upgrade through the proxy; resolves with the
 *  response head plus a socket ready for the post-101 byte pipe. */
function wsUpgrade(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      let raw =
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\n` +
        'Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n';
      for (const [k, v] of Object.entries(headers)) raw += `${k}: ${v}\r\n`;
      socket.write(raw + '\r\n');
    });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('\r\n\r\n')) {
        socket.removeListener('data', onData);
        resolve({ head: buf, socket });
      }
    };
    socket.on('data', onData);
    socket.on('error', reject);
    setTimeout(() => reject(new Error('upgrade timeout')), 3000).unref();
  });
}

async function withProxy(opts, fn) {
  const { server: upstream, state } = makeUpstream();
  const internalPort = await listen(upstream);
  const events = [];
  const proxy = createCdpProxy({
    internalPort,
    externalPort: 0,
    onEvent: (event) => events.push(event),
    ...opts,
  });
  const proxyPort = await listen(proxy);
  try {
    await fn({ proxyPort, internalPort, state, events });
  } finally {
    proxy.close();
    upstream.close();
  }
}

test('forwards HTTP, rewrites Host to loopback, rewrites ws URLs to the external host', async () => {
  await withProxy({}, async ({ proxyPort, internalPort, state }) => {
    const res = await httpGet(proxyPort, '/json/version');
    assert.equal(res.status, 200);
    assert.equal(state.lastRequest.headers.host, `127.0.0.1:${internalPort}`);
    const body = JSON.parse(res.body);
    assert.equal(
      body.webSocketDebuggerUrl,
      `ws://127.0.0.1:${proxyPort}/devtools/browser/stub-uuid-1234`,
      'webSocketDebuggerUrl should point at the host the client used, not the internal port',
    );
  });
});

test('open mode: hostname Host is refused (rebinding guard), IP/localhost pass', async () => {
  await withProxy({}, async ({ proxyPort }) => {
    const ok = await httpGet(proxyPort, '/json/version', { Host: `localhost:${proxyPort}` });
    assert.equal(ok.status, 200);
    const blocked = await httpGet(proxyPort, '/json/version', { Host: 'browser:9222' });
    assert.equal(blocked.status, 403);
  });
});

test('allowHostnames opts into hostname Hosts without a token', async () => {
  await withProxy({ allowHostnames: true }, async ({ proxyPort, state }) => {
    const res = await httpGet(proxyPort, '/json/version', { Host: 'browser:9222' });
    assert.equal(res.status, 200);
    assert.equal(
      JSON.parse(res.body).webSocketDebuggerUrl,
      'ws://browser:9222/devtools/browser/stub-uuid-1234',
    );
    assert.equal(state.lastRequest.headers.host.startsWith('127.0.0.1:'), true);
  });
});

test('token mode: rejects missing/wrong token, accepts all three carriers, allows hostnames', async () => {
  await withProxy({ token: 's3cret' }, async ({ proxyPort, state, events }) => {
    assert.equal((await httpGet(proxyPort, '/json/version')).status, 401);
    assert.equal((await httpGet(proxyPort, '/json/version?token=wrong')).status, 401);
    assert.equal(events.filter((e) => e === 'auth-failure').length, 2);

    assert.equal((await httpGet(proxyPort, '/json/version?token=s3cret')).status, 200);
    assert.equal((await httpGet(proxyPort, '/json/version', { Authorization: 'Bearer s3cret' })).status, 200);
    assert.equal((await httpGet(proxyPort, '/json/version', { 'X-Bridge-Token': 's3cret' })).status, 200);
    // authed requests may come from any Host (auth defeats rebinding)
    assert.equal((await httpGet(proxyPort, '/json/version?token=s3cret', { Host: 'browser:9222' })).status, 200);
    // the token never reaches Chromium — neither as a query param...
    assert.equal(state.lastRequest.path.includes('token'), false);
    // ...nor as an auth header
    assert.equal('authorization' in state.lastRequest.headers, false);
    assert.equal('x-bridge-token' in state.lastRequest.headers, false);
  });
});

test('WebSocket upgrade: auth enforced, then transparent byte pipe', async () => {
  await withProxy({ token: 's3cret' }, async ({ proxyPort, events }) => {
    const denied = await wsUpgrade(proxyPort, '/devtools/browser/stub-uuid-1234');
    assert.match(denied.head, /^HTTP\/1\.1 401 /);
    denied.socket.destroy();

    const { head, socket } = await wsUpgrade(proxyPort, '/devtools/browser/stub-uuid-1234?token=s3cret');
    assert.match(head, /^HTTP\/1\.1 101 /);
    const echoed = await new Promise((resolve) => {
      socket.once('data', (c) => resolve(c.toString('utf8')));
      socket.write('cdp-frame-bytes');
    });
    assert.equal(echoed, 'cdp-frame-bytes');
    assert.equal(events.includes('ws-open'), true);
    socket.destroy();
  });
});

test('root-path upgrade resolves to the browser target server-side', async () => {
  await withProxy({ token: 's3cret' }, async ({ proxyPort, state }) => {
    const { head, socket } = await wsUpgrade(proxyPort, '/?token=s3cret');
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.equal(state.lastUpgrade.path, '/devtools/browser/stub-uuid-1234');
    assert.equal(state.lastUpgrade.path.includes('token'), false);
    socket.destroy();
  });
});

test('upstream down: HTTP gets 502, not a hang', async () => {
  const proxy = createCdpProxy({ internalPort: 9, externalPort: 0 }); // port 9 = discard, nothing listens
  const proxyPort = await listen(proxy);
  try {
    const res = await httpGet(proxyPort, '/json/version');
    assert.equal(res.status, 502);
  } finally {
    proxy.close();
  }
});
