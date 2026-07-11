/**
 * Unit tests for the session broker — run with `node --test test/`.
 *
 * The `launch` dependency is stubbed (no real Chromium): it returns a fake
 * wsEndpoint and records close() calls, so lifecycle, the concurrency cap,
 * ref-counting, reaping, and the health probe are all exercised deterministically.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionBroker } from '../session-broker.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A stub launcher: unique internal port per launch, records closes. */
function stubLauncher() {
  const state = { launches: 0, closes: 0, closedKeys: [], failNext: false, delayMs: 0 };
  const launch = async (key) => {
    if (state.delayMs) await sleep(state.delayMs);
    if (state.failNext) { state.failNext = false; throw new Error('launch failed'); }
    state.launches++;
    const port = 40000 + state.launches;
    return {
      wsEndpoint: `ws://127.0.0.1:${port}/devtools/browser/uuid-${state.launches}`,
      pid: 1000 + state.launches,
      close: async () => { state.closes++; state.closedKeys.push(key); },
    };
  };
  return { launch, state };
}

test('acquire launches once; reuse returns the same session without relaunching', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });
  const a = await broker.acquire('k', false);
  const b = await broker.acquire('k', false);
  assert.equal(state.launches, 1, 'second acquire of same key must not launch');
  assert.equal(a.internalPort, b.internalPort);
  assert.equal(a.wsPath, '/devtools/browser/uuid-1');
  await broker.disposeAll();
});

test('concurrent first-connects on the same key coalesce to one launch', async () => {
  const { launch, state } = stubLauncher();
  state.delayMs = 30;
  const broker = createSessionBroker({ launch });
  const [a, b, c] = await Promise.all([
    broker.acquire('k', false), broker.acquire('k', false), broker.acquire('k', false),
  ]);
  assert.equal(state.launches, 1, 'racing acquisitions must share one launch');
  assert.equal(a.internalPort, c.internalPort);
  assert.equal(b.internalPort, c.internalPort);
  await broker.disposeAll();
});

test('session cap rejects acquisitions past the max', async () => {
  const { launch } = stubLauncher();
  const events = [];
  const broker = createSessionBroker({ launch, maxSessions: 2, onEvent: (e) => events.push(e) });
  await broker.acquire('a', false);
  await broker.acquire('b', false);
  await assert.rejects(() => broker.acquire('c', false), /session cap \(2\)/);
  assert.equal(events.includes('session-rejected'), true);
  await broker.disposeAll();
});

test('ephemeral session is disposed when its last ref releases; named lingers', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });

  const eph = await broker.acquire('e', true); // ephemeral
  eph.release();
  assert.equal(state.closes, 1, 'ephemeral should dispose on last release');
  assert.equal(broker.stats().sessionsActive, 0);

  const named = await broker.acquire('n', false); // named
  named.release();
  assert.equal(broker.stats().sessionsActive, 1, 'named session should linger for reuse');
  await broker.disposeAll();
});

test('ref-counted: an ephemeral session survives while any connection holds it', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });
  const h1 = await broker.acquire('e', true);
  const h2 = await broker.acquire('e', true); // second connection, same session
  h1.release();
  assert.equal(state.closes, 0, 'still one ref held — must not dispose');
  h2.release();
  assert.equal(state.closes, 1, 'last ref gone — now disposes');
});

test('release() is idempotent (double close does not over-decrement)', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });
  const h1 = await broker.acquire('e', true);
  const h2 = await broker.acquire('e', true);
  h1.release();
  h1.release(); // duplicate — must be a no-op
  assert.equal(state.closes, 0, 'session still referenced by h2');
  h2.release();
  assert.equal(state.closes, 1);
});

test('reap disposes idle, unreferenced sessions past the TTL', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch, idleTtlMs: 0 });
  const h = await broker.acquire('n', false);
  h.release();
  await sleep(5);
  await broker.reap();
  assert.equal(state.closes, 1, 'idle named session should be reaped');
  assert.equal(broker.stats().sessionsActive, 0);
});

test('reap spares sessions with active references', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch, idleTtlMs: 0 });
  await broker.acquire('held', false); // never released
  await sleep(5);
  await broker.reap();
  assert.equal(state.closes, 0, 'referenced session must not be reaped');
  await broker.disposeAll();
});

test('probe reports ok when a launch succeeds and leaves no session behind', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });
  assert.equal(await broker.probe(), 'ok');
  assert.equal(broker.stats().sessionsActive, 0, 'probe session must be disposed');
  assert.equal(state.closes, 1);
});

test('probe reports degraded when launch fails', async () => {
  const { launch, state } = stubLauncher();
  state.failNext = true;
  const broker = createSessionBroker({ launch });
  assert.equal(await broker.probe(), 'degraded');
  assert.equal(broker.stats().sessionsActive, 0);
});

test('a failed launch frees its reserved slot (cap not permanently consumed)', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch, maxSessions: 1 });
  state.failNext = true;
  await assert.rejects(() => broker.acquire('x', false), /launch failed/);
  assert.equal(broker.stats().sessionsActive, 0, 'failed launch must not hold the slot');
  // maxSessions is 1, so this only succeeds if the failed launch freed its
  // reserved slot. The stub counts launches only on success, so this is the
  // first successful launch -> port 40001.
  const ok = await broker.acquire('y', false);
  assert.equal(ok.internalPort, 40001);
  await broker.disposeAll();
});

test('disposeAll closes every live session', async () => {
  const { launch, state } = stubLauncher();
  const broker = createSessionBroker({ launch });
  await broker.acquire('a', false);
  await broker.acquire('b', false);
  await broker.disposeAll();
  assert.equal(state.closes, 2);
  assert.equal(broker.stats().sessionsActive, 0);
});
