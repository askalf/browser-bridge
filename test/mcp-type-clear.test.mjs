/**
 * browser_type's `clear` in a real browser replaces the whole value of a multi-line textarea,
 * a multi-paragraph contenteditable and an input. Runs against the Chrome that GitHub's ubuntu
 * runners ship (or CHROME_PATH); skips where there is none.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSessionServer } from '../mcp-server.mjs';

const CHROME = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => p && existsSync(p));

const PAGE = `<!doctype html><body>
  <textarea id="ta">first
second
third</textarea>
  <div id="ce" contenteditable="true"><p>one</p><p>two</p><p>three</p></div>
  <input id="in" value="old value">
</body>`;

test('browser_type clear empties multi-line fields in a real browser', { skip: CHROME ? false : 'no Chrome on this machine' }, async () => {
  // pipe: true, so no debugging port is opened; puppeteer uses a fresh temporary profile.
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, pipe: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(PAGE);
    const server = buildSessionServer({ id: 'real' }, () => ({ page, consoleBuffer: [], dispose: async () => {} }), () => {});
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const type = (selector, text) => client.callTool({ name: 'browser_type', arguments: { selector, text, clear: true } });

    await type('#ta', 'replacement');
    assert.equal(await page.$eval('#ta', (el) => el.value), 'replacement');

    await type('#ce', 'replacement');
    assert.equal(await page.$eval('#ce', (el) => el.innerText.trim()), 'replacement');

    await type('#in', 'new');
    assert.equal(await page.$eval('#in', (el) => el.value), 'new');
  } finally {
    await browser.close();
  }
});
