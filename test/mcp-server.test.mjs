/**
 * Unit tests for the MCP endpoint's tools. A fake "connect" returns a fake
 * page (no real browser), and a real MCP Client is linked to the per-session
 * server over an in-memory transport, so tool registration, arguments, and
 * result shapes are asserted end-to-end without Chromium or HTTP.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { buildSessionServer } from '../mcp-server.mjs';

function fakeBrowser(overrides = {}) {
  const calls = [];
  const page = {
    calls,
    waitForSelector: async (sel, opts) => { calls.push(['waitForSelector', sel, opts]); return {}; },
    waitForFunction: async (fn, opts, arg) => { calls.push(['waitForFunction', opts, arg]); return {}; },
    click: async (sel, opts) => { calls.push(['click', sel, opts]); },
    type: async (sel, value, opts) => { calls.push(['type', sel, value, opts]); },
    $eval: async (sel, fn) => { calls.push(['$eval', sel, fn.name]); },
    keyboard: { press: async (key) => { calls.push(['press', key]); } },
    url: () => 'https://example.com/',
    title: async () => 'Example Domain',
    goto: async () => ({ status: () => 200 }),
    evaluate: async (expr) =>
      (expr.includes('innerText') ? 'VISIBLE TEXT' : 42),
    content: async () => '<html><body>hi</body></html>',
    screenshot: async () => 'ZmFrZS1wbmc=', // "fake-png" base64
    pdf: async () => Buffer.from('%PDF-1.4 fake'),
    close: async () => {},
    ...overrides,
  };
  return { page, consoleBuffer: [{ type: 'log', text: 'hello world' }], dispose: async () => {} };
}

async function linkClient(connect) {
  const rec = { id: 'test-session' };
  const server = buildSessionServer(rec, connect, () => {});
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, rec };
}

test('reports the package.json version to MCP clients', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(client.getServerVersion(), { name: 'browser-bridge', version: pkg.version });
});

test('lists the nine browser tools', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'browser_click', 'browser_evaluate', 'browser_get_console', 'browser_get_content',
    'browser_navigate', 'browser_pdf', 'browser_screenshot', 'browser_type', 'browser_wait_for',
  ]);
});

test('browser_navigate goes to the URL and reports status + title', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const r = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.com' } });
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[0].text, /navigated to https:\/\/example\.com\/ \(status 200\)/);
  assert.match(r.content[0].text, /title: Example Domain/);
});

test('browser_evaluate returns the JSON-serialized result', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const r = await client.callTool({ name: 'browser_evaluate', arguments: { expression: '20 + 22' } });
  assert.equal(r.content[0].text, '42');
});

test('browser_screenshot returns image content', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const r = await client.callTool({ name: 'browser_screenshot', arguments: { fullPage: true } });
  assert.equal(r.content[0].type, 'image');
  assert.equal(r.content[0].mimeType, 'image/png');
  assert.equal(r.content[0].data, 'ZmFrZS1wbmc=');
});

test('browser_get_content returns html by default and text on request', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const html = await client.callTool({ name: 'browser_get_content', arguments: {} });
  assert.match(html.content[0].text, /<body>hi<\/body>/);
  const txt = await client.callTool({ name: 'browser_get_content', arguments: { format: 'text' } });
  assert.equal(txt.content[0].text, 'VISIBLE TEXT');
});

test('browser_get_content truncates past maxChars', async () => {
  const big = 'x'.repeat(500);
  const { client } = await linkClient(() => fakeBrowser({ content: async () => big }));
  const r = await client.callTool({ name: 'browser_get_content', arguments: { maxChars: 100 } });
  assert.match(r.content[0].text, /^x{100}\n…\[truncated 400 chars\]$/);
});

test('browser_get_console returns the buffered lines and can clear them', async () => {
  const browser = fakeBrowser();
  const { client } = await linkClient(() => browser);
  const r = await client.callTool({ name: 'browser_get_console', arguments: {} });
  assert.match(r.content[0].text, /\[log\] hello world/);
  await client.callTool({ name: 'browser_get_console', arguments: { clear: true } });
  assert.equal(browser.consoleBuffer.length, 0);
});

test('browser_pdf returns an embedded application/pdf resource', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const r = await client.callTool({ name: 'browser_pdf', arguments: {} });
  assert.equal(r.content[0].type, 'resource');
  assert.equal(r.content[0].resource.mimeType, 'application/pdf');
  assert.equal(Buffer.from(r.content[0].resource.blob, 'base64').toString(), '%PDF-1.4 fake');
});

test('a tool failure surfaces as an isError result, not a transport crash', async () => {
  const connect = () => fakeBrowser({ goto: async () => { throw new Error('nav boom'); } });
  const { client } = await linkClient(connect);
  const r = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://x.test' } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /navigate failed: nav boom/);
});

test('the browser connection is lazy — not opened until the first tool call', async () => {
  let connects = 0;
  const connect = () => { connects++; return fakeBrowser(); };
  const { client } = await linkClient(connect);
  await client.listTools();
  assert.equal(connects, 0, 'listing tools must not open a browser');
  await client.callTool({ name: 'browser_evaluate', arguments: { expression: '1' } });
  assert.equal(connects, 1, 'first tool call opens exactly one connection');
  await client.callTool({ name: 'browser_evaluate', arguments: { expression: '2' } });
  assert.equal(connects, 1, 'subsequent calls reuse it');
});

test('browser_click waits for a visible element, then clicks it with puppeteer input', async () => {
  const browser = fakeBrowser();
  const { client } = await linkClient(() => browser);
  const r = await client.callTool({ name: 'browser_click', arguments: { selector: '#go', clickCount: 2 } });
  assert.match(r.content[0].text, /^clicked #go\nurl: https:\/\/example\.com\/$/);
  assert.deepEqual(browser.page.calls, [
    ['waitForSelector', '#go', { visible: true, timeout: 10_000 }],
    ['click', '#go', { button: 'left', count: 2 }],
  ]);
});

test('browser_click reports a missing element as an isError result', async () => {
  const connect = () => fakeBrowser({ waitForSelector: async () => { throw new Error('Waiting for selector `#nope` failed'); } });
  const { client } = await linkClient(connect);
  const r = await client.callTool({ name: 'browser_click', arguments: { selector: '#nope', timeoutMs: 50 } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /click failed: Waiting for selector `#nope` failed/);
});

test('browser_type clears, types, submits, and never echoes the typed text', async () => {
  const browser = fakeBrowser();
  const { client } = await linkClient(() => browser);
  const r = await client.callTool({
    name: 'browser_type',
    arguments: { selector: 'input[name=pw]', text: 'hunter2-secret', clear: true, submit: true },
  });
  assert.equal(r.content[0].text, 'typed 14 chars into input[name=pw] and pressed Enter');
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  assert.deepEqual(browser.page.calls, [
    ['waitForSelector', 'input[name=pw]', { visible: true, timeout: 10_000 }],
    ['$eval', 'input[name=pw]', 'selectAllContent'],
    ['press', 'Backspace'],
    ['type', 'input[name=pw]', 'hunter2-secret', { delay: 0 }],
    ['press', 'Enter'],
  ]);
});

test('browser_type without clear or submit only types', async () => {
  const browser = fakeBrowser();
  const { client } = await linkClient(() => browser);
  await client.callTool({ name: 'browser_type', arguments: { selector: '#q', text: 'hi', delayMs: 20 } });
  assert.deepEqual(browser.page.calls.map((c) => c[0]), ['waitForSelector', 'type']);
  assert.deepEqual(browser.page.calls[1], ['type', '#q', 'hi', { delay: 20 }]);
});

test('browser_wait_for waits on a selector or on page text', async () => {
  const browser = fakeBrowser();
  const { client } = await linkClient(() => browser);
  const a = await client.callTool({ name: 'browser_wait_for', arguments: { selector: '.done', timeoutMs: 500 } });
  assert.match(a.content[0].text, /^found \.done after \d+ms$/);
  const b = await client.callTool({ name: 'browser_wait_for', arguments: { text: 'Welcome back' } });
  assert.match(b.content[0].text, /^found "Welcome back" after \d+ms$/);
  assert.deepEqual(browser.page.calls, [
    ['waitForSelector', '.done', { visible: true, timeout: 500 }],
    ['waitForFunction', { timeout: 10_000 }, 'Welcome back'],
  ]);
});

test('browser_wait_for needs exactly one of selector or text, and checks before connecting', async () => {
  let connects = 0;
  const { client } = await linkClient(() => { connects++; return fakeBrowser(); });
  for (const args of [{}, { selector: 'a', text: 'b' }]) {
    const r = await client.callTool({ name: 'browser_wait_for', arguments: args });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /exactly one of selector or text/);
  }
  assert.equal(connects, 0, 'a bad call must not open a browser');
});

test('input tools reject a timeout past the navigation cap', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const r = await client.callTool({ name: 'browser_click', arguments: { selector: 'a', timeoutMs: 999_999 } });
  assert.equal(r.isError, true);
});
