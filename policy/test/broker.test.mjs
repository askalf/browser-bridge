/**
 * ContextBroker — pool/lock/eviction/keeper-login logic, exercised against a fake
 * puppeteer Browser (no real Chrome, so it runs in CI like the rest of the suite).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ContextBroker } from '../src/broker.mjs';
import { GovernedBrowser, KeeperStub } from '../src/govern.mjs';
import { captureFromBridge } from '../src/capture.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

function fakeBrowser() {
  const events = { created: 0, disconnected: 0, closedContexts: 0, browserClosed: false };
  const browser = {
    async createBrowserContext() {
      events.created++;
      const page = {
        typed: [], gotos: [], clicks: [],
        url: () => 'about:blank',
        async setCacheEnabled() {},
        async goto(u) { this.gotos.push(u); },
        async type(s, v) { this.typed.push([s, v]); },
        async click(s) { this.clicks.push(s); },
        async evaluate() { return { title: 't', nodes: [] }; },
      };
      return {
        _page: page, closed: false,
        async newPage() { return page; },
        async close() { this.closed = true; events.closedContexts++; },
      };
    },
    async disconnect() { events.disconnected++; },
    async close() { events.browserClosed = true; }, // must NEVER be called
  };
  return { browser, events };
}

test('broker: one isolated context per persona; reused (not recreated) across checkouts', async () => {
  const { browser, events } = fakeBrowser();
  const b = new ContextBroker({ browser });
  const a1 = await b.checkout('alpha'); b.checkin('alpha');
  const a2 = await b.checkout('alpha'); b.checkin('alpha');
  assert.equal(a1.context, a2.context, 'same persona reuses its context');
  assert.equal(events.created, 1, 'context created once');
  const beta = await b.checkout('beta');
  assert.notEqual(beta.context, a1.context, 'different personas are isolated');
  assert.equal(events.created, 2);
});

test('broker: per-persona lock serializes concurrent checkouts', async () => {
  const { browser } = fakeBrowser();
  const b = new ContextBroker({ browser });
  const h1 = await b.checkout('p');
  let resolved = false;
  const p2 = b.checkout('p').then((h) => { resolved = true; return h; });
  await tick();
  assert.equal(resolved, false, 'second checkout blocks while persona is busy');
  b.checkin('p');
  const h2 = await p2;
  assert.equal(resolved, true);
  assert.equal(h2.context, h1.context, 'waiter gets the same context');
});

test('broker: bounded pool evicts the LRU idle context', async () => {
  const { browser, events } = fakeBrowser();
  const b = new ContextBroker({ browser, maxContexts: 2 });
  await b.checkout('a'); b.checkin('a');
  await b.checkout('b'); b.checkin('b');
  assert.equal(b.stats().size, 2);
  await b.checkout('c'); // must evict the LRU idle (a)
  const st = b.stats();
  assert.equal(st.size, 2, 'pool stays bounded');
  assert.ok(!st.personas.includes('a'), 'LRU idle (a) evicted');
  assert.ok(st.personas.includes('b') && st.personas.includes('c'));
  assert.equal(events.closedContexts, 1, 'evicted context was closed');
});

test('broker: at capacity with all busy, a new persona throws', async () => {
  const { browser } = fakeBrowser();
  const b = new ContextBroker({ browser, maxContexts: 1 });
  await b.checkout('a'); // busy, not checked in
  await assert.rejects(() => b.checkout('b'), /at capacity/);
});

test('broker: keeper login runs once on create, never re-runs, never leaks the secret', async () => {
  const { browser } = fakeBrowser();
  const keeper = new KeeperStub({ acme: { user: 'ap-bot@acme.example', pass: 'vault-secret-xyz' } });
  const b = new ContextBroker({
    browser, keeper,
    loginConfig: { acme: { url: 'https://acme.example/login', userSelector: '#u', passSelector: '#p', submitSelector: '#go' } },
  });
  const h = await b.checkout('acme');
  assert.deepEqual(h.page.gotos, ['https://acme.example/login']);
  assert.deepEqual(h.page.typed, [['#u', 'ap-bot@acme.example'], ['#p', 'vault-secret-xyz']]);
  assert.deepEqual(h.page.clicks, ['#go']);
  // secret is filled at the CDP layer but never exposed on the handle
  assert.ok(!JSON.stringify(Object.keys(h)).includes('pass'));
  assert.equal(h.persona, 'acme');
  b.checkin('acme');
  const h2 = await b.checkout('acme'); // reuse — no second login
  assert.equal(h2.page.typed.length, 2, 'login not repeated on reuse');
});

test('broker: close() closes every context + disconnects, never browser.close()', async () => {
  const { browser, events } = fakeBrowser();
  const b = new ContextBroker({ browser });
  await b.checkout('a'); b.checkin('a');
  await b.checkout('b'); b.checkin('b');
  await b.close();
  assert.equal(events.closedContexts, 2);
  assert.equal(events.disconnected, 1);
  assert.equal(events.browserClosed, false, 'NEVER browser.close() — shared prod bridge');
  await assert.rejects(() => b.checkout('c'), /closed/);
});

test('broker: withPersona checks back in even when the body throws', async () => {
  const { browser } = fakeBrowser();
  const b = new ContextBroker({ browser });
  await assert.rejects(() => b.withPersona('p', async () => { throw new Error('boom'); }), /boom/);
  // if it was checked back in, this resolves immediately (not blocked)
  const h = await Promise.race([b.checkout('p'), new Promise((_, rej) => setTimeout(() => rej(new Error('blocked')), 50))]);
  assert.equal(h.persona, 'p');
});

test('captureFromBridge reuses a provided page (broker session) without touching its lifecycle', async () => {
  const page = { gotos: [], async goto(u) { this.gotos.push(u); }, async evaluate() { return { title: 'X', nodes: [{ id: 'n0', text: 'hi', source: 'text', tag: 'p', hidden: false, hiddenReasons: [] }] }; }, url: () => 'https://acme.example/p' };
  const obs = await captureFromBridge({ page, url: 'https://acme.example/p' });
  assert.equal(obs.capturedBy, 'cdp');
  assert.deepEqual(page.gotos, ['https://acme.example/p']);
  assert.equal(obs.nodes.length, 1);
  assert.equal(obs.origin, 'https://acme.example');
});

test('observe({page}) routes through the live-capture path, not the static parser', async () => {
  const page = {
    gotos: [],
    async goto(u) { this.gotos.push(u); },
    async evaluate() {
      return { title: 'Live', nodes: [{ id: 'n0', text: 'hello from the live page', source: 'text', tag: 'p', hidden: false, hiddenReasons: [] }] };
    },
    url: () => 'https://live.example/session',
  };
  const gov = new GovernedBrowser();
  const res = await gov.observe({ page });
  // Regression: a bare {page} used to miss the hasBridge check and fall
  // through to captureFromHtml(undefined). It must read the LIVE page.
  assert.equal(res.observation.capturedBy, 'cdp');
  assert.equal(res.observation.url, 'https://live.example/session');
  assert.deepEqual(page.gotos, []); // current state read as-is, no navigation
  assert.ok(res.safe.text.includes('hello from the live page'));
});
