/**
 * browser-bridge MCP endpoint — drive the bridge from any MCP client with no
 * puppeteer/CDP code of your own.
 *
 * It's a thin MCP server that is itself a CDP *client* of the bridge: each MCP
 * session opens one connection to the bridge (`?session=mcp-<id>`), so in
 * isolated mode (BRIDGE_SESSION_MODE=isolated) every MCP session gets its own
 * stealth browser for free; in shared mode they share the one browser, exactly
 * like any other CDP client. Stealth, VPN routing, reaping — all inherited from
 * the bridge; this layer just exposes navigate/screenshot/evaluate/content/
 * console/pdf as MCP tools over Streamable HTTP.
 *
 * Run standalone alongside the bridge:
 *   BRIDGE_CDP_URL=http://127.0.0.1:9222 node mcp-server.mjs
 * then point an MCP client at http://<host>:9225/mcp.
 *
 * Env:
 *   BRIDGE_MCP_PORT   — HTTP port for the MCP endpoint. Default 9225.
 *   BRIDGE_MCP_PATH   — request path. Default /mcp.
 *   BRIDGE_CDP_URL    — the bridge's CDP endpoint. Default http://127.0.0.1:9222.
 *   BRIDGE_TOKEN      — if set, required on MCP requests (Bearer / X-Bridge-Token
 *                       / ?token=) AND presented to the bridge's CDP endpoint.
 *
 * IMPORTANT: all diagnostic logging goes to stderr — stdout is reserved so this
 * can also be spoken to over stdio without corrupting the protocol stream.
 */

import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const CONSOLE_CAP = 200;
const CONTENT_CAP = 100_000;
const NAV_TIMEOUT_MS = 45_000;

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const errText = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

function pushCapped(buf, item) {
  buf.push(item);
  if (buf.length > CONSOLE_CAP) buf.shift();
}

// ── Default browser connector — one bridge connection + page per MCP session ──
function toWs(cdpUrl) {
  return cdpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
}
function browserWsEndpoint(cdpUrl, sessionKey, token) {
  const q = new URLSearchParams({ session: sessionKey });
  if (token) q.set('token', token);
  return `${toWs(cdpUrl)}/?${q.toString()}`;
}

async function defaultConnect(cdpUrl, token, sessionKey) {
  const browser = await puppeteer.connect({ browserWSEndpoint: browserWsEndpoint(cdpUrl, sessionKey, token) });
  const page = await browser.newPage();
  const consoleBuffer = [];
  page.on('console', (m) => pushCapped(consoleBuffer, { type: m.type(), text: m.text() }));
  page.on('pageerror', (e) => pushCapped(consoleBuffer, { type: 'pageerror', text: String(e?.message || e) }));
  return {
    page,
    consoleBuffer,
    dispose: async () => {
      // disconnect(), never close(): in shared mode close() would kill the
      // fleet's browser; in isolated mode the bridge reaps the session once
      // our CDP connection drops.
      try { await page.close(); } catch { /* gone */ }
      try { await browser.disconnect(); } catch { /* gone */ }
    },
  };
}

// ── Per-session MCP server: the six browser tools bound to one lazy page ──
export function buildSessionServer(rec, connect, log) {
  const mcp = new McpServer(
    { name: 'browser-bridge', version: '0.3.0' },
    { capabilities: { tools: {} } },
  );

  // Lazily open the bridge connection on first tool use, so an MCP session that
  // only initializes never launches a browser.
  rec.resolve = async () => {
    if (rec.browser) return rec.browser;
    if (!rec.connecting) {
      rec.connecting = Promise.resolve(connect(`mcp-${rec.id ?? 'pending'}`))
        .then((b) => { rec.browser = b; rec.connecting = null; return b; })
        .catch((e) => { rec.connecting = null; throw e; });
    }
    return rec.connecting;
  };
  const getPage = async () => (await rec.resolve()).page;

  mcp.registerTool('browser_navigate', {
    title: 'Navigate',
    description: 'Navigate the browser to a URL and wait for it to load.',
    inputSchema: {
      url: z.string().describe('Absolute URL to open'),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle0', 'networkidle2']).optional()
        .describe('Puppeteer load condition (default: load)'),
    },
  }, async ({ url, waitUntil }) => {
    try {
      const page = await getPage();
      const resp = await page.goto(url, { waitUntil: waitUntil || 'load', timeout: NAV_TIMEOUT_MS });
      return text(`navigated to ${page.url()} (status ${resp?.status?.() ?? 'n/a'})\ntitle: ${await page.title()}`);
    } catch (e) { return errText(`navigate failed: ${e.message}`); }
  });

  mcp.registerTool('browser_screenshot', {
    title: 'Screenshot',
    description: 'Capture a PNG screenshot of the current page.',
    inputSchema: { fullPage: z.boolean().optional().describe('Capture the full scrollable page (default: viewport only)') },
  }, async ({ fullPage }) => {
    try {
      const page = await getPage();
      const data = await page.screenshot({ fullPage: !!fullPage, encoding: 'base64', type: 'png' });
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] };
    } catch (e) { return errText(`screenshot failed: ${e.message}`); }
  });

  mcp.registerTool('browser_evaluate', {
    title: 'Evaluate JavaScript',
    description: 'Evaluate a JavaScript expression in the page and return the (JSON-serializable) result.',
    inputSchema: { expression: z.string().describe('A JS expression evaluated in page context, e.g. "document.title"') },
  }, async ({ expression }) => {
    try {
      const page = await getPage();
      const r = await page.evaluate(expression);
      return text(typeof r === 'undefined' ? 'undefined' : JSON.stringify(r));
    } catch (e) { return errText(`evaluate failed: ${e.message}`); }
  });

  mcp.registerTool('browser_get_content', {
    title: 'Get page content',
    description: 'Return the current page as HTML or visible text.',
    inputSchema: {
      format: z.enum(['html', 'text']).optional().describe('html (default) or text (visible innerText)'),
      maxChars: z.number().int().positive().optional().describe(`Truncate beyond this many chars (default ${CONTENT_CAP})`),
    },
  }, async ({ format, maxChars }) => {
    try {
      const page = await getPage();
      const raw = format === 'text'
        ? await page.evaluate('document.body ? document.body.innerText : ""')
        : await page.content();
      const cap = maxChars || CONTENT_CAP;
      return text(raw.length > cap ? `${raw.slice(0, cap)}\n…[truncated ${raw.length - cap} chars]` : raw);
    } catch (e) { return errText(`get_content failed: ${e.message}`); }
  });

  mcp.registerTool('browser_get_console', {
    title: 'Get console output',
    description: 'Return console + page-error messages captured since the session started.',
    inputSchema: { clear: z.boolean().optional().describe('Clear the buffer after reading') },
  }, async ({ clear }) => {
    try {
      const b = await rec.resolve();
      const lines = b.consoleBuffer.map((c) => `[${c.type}] ${c.text}`);
      if (clear) b.consoleBuffer.length = 0;
      return text(lines.length ? lines.join('\n') : '(no console output captured)');
    } catch (e) { return errText(`get_console failed: ${e.message}`); }
  });

  mcp.registerTool('browser_pdf', {
    title: 'Render PDF',
    description: 'Render the current page to a PDF (returned as an embedded resource).',
    inputSchema: {},
  }, async () => {
    try {
      const page = await getPage();
      const buf = await page.pdf({ printBackground: true });
      return { content: [{ type: 'resource', resource: { uri: 'browser://page.pdf', mimeType: 'application/pdf', blob: Buffer.from(buf).toString('base64') } }] };
    } catch (e) { return errText(`pdf failed: ${e.message}`); }
  });

  return mcp;
}

// ── HTTP layer: stateful Streamable-HTTP, one MCP session ⇒ one bridge session ──
export function createMcpBridgeServer({ cdpUrl = 'http://127.0.0.1:9222', token = '', path = '/mcp', connect, log = () => {} } = {}) {
  const doConnect = connect || ((key) => defaultConnect(cdpUrl, token, key));
  const sessions = new Map(); // mcpSessionId -> rec

  const tokenOk = (req, url) => {
    if (!token) return true;
    const auth = req.headers['authorization'];
    const presented = (typeof auth === 'string' && auth.startsWith('Bearer ') && auth.slice(7))
      || req.headers['x-bridge-token']
      || url.searchParams.get('token')
      || '';
    if (typeof presented !== 'string' || presented.length === 0) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const readJson = (req) => new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve(undefined); return; }
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });

  const isInitialize = (body) =>
    (Array.isArray(body) ? body : [body]).some((m) => m && m.method === 'initialize');

  async function cleanup(rec) {
    if (rec.id) sessions.delete(rec.id);
    if (rec.browser) { try { await rec.browser.dispose(); } catch { /* gone */ } rec.browser = null; }
  }

  async function createSession() {
    const rec = { id: null, transport: null, server: null, browser: null, connecting: null };
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => { rec.id = sid; sessions.set(sid, rec); log(`mcp session ${sid} initialized`); },
    });
    transport.onclose = () => { cleanup(rec); log(`mcp session ${rec.id} closed`); };
    rec.transport = transport;
    rec.server = buildSessionServer(rec, doConnect, log);
    await rec.server.connect(transport);
    return rec;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://mcp.invalid');
    if (!tokenOk(req, url)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'browser-bridge mcp: missing or invalid token' }));
      return;
    }
    if (url.pathname !== path) { res.writeHead(404).end(); return; }

    const sid = req.headers['mcp-session-id'];
    try {
      if (req.method === 'POST') {
        const body = await readJson(req);
        let rec = typeof sid === 'string' ? sessions.get(sid) : null;
        if (!rec) {
          if (!isInitialize(body)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null }));
            return;
          }
          rec = await createSession();
        }
        await rec.transport.handleRequest(req, res, body);
      } else if (req.method === 'GET' || req.method === 'DELETE') {
        const rec = typeof sid === 'string' ? sessions.get(sid) : null;
        if (!rec) { res.writeHead(400).end(); return; }
        await rec.transport.handleRequest(req, res);
      } else {
        res.writeHead(405).end();
      }
    } catch (e) {
      log(`request error: ${e.message}`);
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
    }
  });

  return {
    server,
    listen: (port, host = '0.0.0.0') => new Promise((r) => server.listen(port, host, () => r(server.address().port))),
    close: async () => {
      for (const rec of [...sessions.values()]) await cleanup(rec);
      server.close();
    },
    sessionCount: () => sessions.size,
  };
}

// ── Standalone entrypoint ────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = parseInt(process.env.BRIDGE_MCP_PORT || '9225', 10);
  const path = process.env.BRIDGE_MCP_PATH || '/mcp';
  const cdpUrl = process.env.BRIDGE_CDP_URL || 'http://127.0.0.1:9222';
  const token = process.env.BRIDGE_TOKEN || '';
  const mcp = createMcpBridgeServer({ cdpUrl, token, path, log: (m) => console.error(`[browser-bridge mcp] ${m}`) });
  await mcp.listen(port);
  console.error(`[browser-bridge mcp] listening on http://0.0.0.0:${port}${path} → CDP ${cdpUrl}${token ? ' (token required)' : ''}`);
  const bye = async () => { await mcp.close(); process.exit(0); };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
