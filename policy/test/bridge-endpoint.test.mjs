import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeEndpoint } from '../src/capture.mjs';

// A bridge that advertises its INTERNAL address (what a tunnelled or
// port-forwarded askalf/browser-bridge does) and requires BRIDGE_TOKEN.
function stubFetch(calls, { status = 200, wsUrl = 'ws://172.27.0.2:9222/devtools/browser/abc-123' } = {}) {
  return async (url) => {
    calls.push(String(url));
    return { ok: status === 200, status, json: async () => ({ webSocketDebuggerUrl: wsUrl }) };
  };
}

test('plain base: /json/version fetched, ws host rewritten to the base host, no token added', async () => {
  const calls = [];
  const ws = await bridgeEndpoint('http://127.0.0.1:9222', { fetch: stubFetch(calls) });
  assert.deepEqual(calls, ['http://127.0.0.1:9222/json/version']);
  assert.equal(ws, 'ws://127.0.0.1:9222/devtools/browser/abc-123');
});

test('browserless-style ?token= rides on /json/version AND on the ws endpoint', async () => {
  const calls = [];
  const ws = await bridgeEndpoint('http://127.0.0.1:9333/?token=s3cr3t', { fetch: stubFetch(calls) });
  assert.deepEqual(calls, ['http://127.0.0.1:9333/json/version?token=s3cr3t']);
  const u = new URL(ws);
  assert.equal(u.host, '127.0.0.1:9333');
  assert.equal(u.pathname, '/devtools/browser/abc-123');
  assert.equal(u.searchParams.get('token'), 's3cr3t');
});

test('a token never becomes part of the path (the old string concat bug)', async () => {
  const calls = [];
  await bridgeEndpoint('http://127.0.0.1:9333/?token=s3cr3t', { fetch: stubFetch(calls) });
  assert.ok(!calls[0].includes('?token=s3cr3t/json/version'));
});

test('401 from the bridge names the token as the likely cause', async () => {
  await assert.rejects(
    () => bridgeEndpoint('http://127.0.0.1:9333', { fetch: stubFetch([], { status: 401 }) }),
    /HTTP 401 .*token/,
  );
});

test('a base with a trailing slash or path resolves /json/version at the origin', async () => {
  const calls = [];
  await bridgeEndpoint('http://127.0.0.1:9222/', { fetch: stubFetch(calls) });
  assert.deepEqual(calls, ['http://127.0.0.1:9222/json/version']);
});
