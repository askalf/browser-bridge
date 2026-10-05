/**
 * HTTP-layer tests for the MCP endpoint (createMcpBridgeServer): malformed
 * request paths, body size limits, and reclaiming sessions whose client went
 * away without a DELETE. The browser connection is stubbed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createMcpBridgeServer } from '../mcp-server.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const INIT = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } },
};

async function withServer(opts, fn) {
  const mcp = createMcpBridgeServer({ connect: async () => ({ dispose: async () => {} }), ...opts });
  const port = await mcp.listen(0, '127.0.0.1');
  try { await fn({ mcp, port }); } finally { await mcp.close(); }
}

/** Send raw bytes, resolve with the status line (or '' if the socket closed). */
function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(raw));
    let buf = '';
    s.on('data', (c) => { buf += c; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
    s.on('close', () => resolve(buf.split('\r\n')[0]));
    s.on('error', reject);
  });
}

const post = (port, body, headers = {}) => fetch(`http://127.0.0.1:${port}/mcp`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

test('an unparseable request path gets 400 and the server stays up', async () => {
  await withServer({ token: 'secret' }, async ({ port }) => {
    for (const p of ['//', '///', '//a:b@']) {
      assert.equal(await rawRequest(port, `GET ${p} HTTP/1.1\r\nHost: x\r\n\r\n`), 'HTTP/1.1 400 Bad Request', p);
    }
    const res = await post(port, INIT, { Authorization: 'Bearer secret' });
    assert.equal(res.status, 200, 'still serving after the bad requests');
    await res.body?.cancel();
  });
});

test('a body past maxBodyBytes is refused with 413 and creates no session', async () => {
  await withServer({ maxBodyBytes: 1024 }, async ({ mcp, port }) => {
    const res = await post(port, { ...INIT, pad: 'x'.repeat(4096) });
    assert.equal(res.status, 413);
    assert.equal(mcp.sessionCount(), 0);
  });
});

test('a session whose client never sends DELETE is closed once idle', async () => {
  let disposed = 0;
  const connect = async () => ({ dispose: async () => { disposed++; } });
  await withServer({ connect, sessionIdleMs: 50 }, async ({ mcp, port }) => {
    const res = await post(port, INIT);
    assert.equal(res.status, 200);
    await res.body?.cancel();
    assert.equal(mcp.sessionCount(), 1);
    for (let i = 0; i < 40 && mcp.sessionCount() > 0; i++) await sleep(25);
    assert.equal(mcp.sessionCount(), 0, 'idle session must be reclaimed');
    assert.equal(disposed, 0, 'no browser was ever opened, so there is nothing to dispose');
  });
});

test('an open GET stream keeps its session alive past the idle window', async () => {
  await withServer({ sessionIdleMs: 50 }, async ({ mcp, port }) => {
    const init = await post(port, INIT);
    const sid = init.headers.get('mcp-session-id');
    await init.body?.cancel();
    const ac = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/mcp`, {
      headers: { Accept: 'text/event-stream', 'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18' },
      signal: ac.signal,
    });
    assert.equal(stream.status, 200);
    await sleep(250);
    assert.equal(mcp.sessionCount(), 1, 'a listening client is not idle');
    ac.abort();
    for (let i = 0; i < 40 && mcp.sessionCount() > 0; i++) await sleep(25);
    assert.equal(mcp.sessionCount(), 0, 'reclaimed once the stream closes and the window passes');
  });
});

test('a POST still uploading when the idle window passes keeps its session', async () => {
  await withServer({ sessionIdleMs: 50 }, async ({ mcp, port }) => {
    const init = await post(port, INIT);
    const sid = init.headers.get('mcp-session-id');
    await init.body?.cancel();
    const http = await import('node:http');
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/mcp', method: 'POST',
        headers: {
          'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          'mcp-session-id': sid, 'mcp-protocol-version': '2025-06-18',
        },
      }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      req.write(body.slice(0, 10)); // the request has started...
      setTimeout(() => req.end(body.slice(10)), 250); // ...and finishes well past the idle window
    });
    assert.equal(status, 200, 'the session was not expired mid-upload');
    assert.equal(mcp.sessionCount(), 1);
  });
});
