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
import { buildSessionServer } from '../mcp-server.mjs';

function fakeBrowser(overrides = {}) {
  const page = {
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

test('lists the six browser tools', async () => {
  const { client } = await linkClient(() => fakeBrowser());
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'browser_evaluate', 'browser_get_console', 'browser_get_content',
    'browser_navigate', 'browser_pdf', 'browser_screenshot',
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
