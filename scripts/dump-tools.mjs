#!/usr/bin/env node
// Writes the tool surface of both MCP servers in this repo to mcp/, where
// truecopy.lock pins it:
//   mcp/browser-bridge.json   mcp-server.mjs (browser_navigate, browser_evaluate, ...)
//   mcp/fieldpass.json        policy/src/mcp.mjs (picket_observe, picket_gate, ...)
//
// Each file is the server's real tools/list response, read by an MCP client over
// an in-memory transport. Listing tools never opens a browser: the bridge server
// connects lazily on the first tool call, and fieldpass fetches nothing until a
// tool runs.
//
//   node scripts/dump-tools.mjs           regenerate both manifests
//   node scripts/dump-tools.mjs --check   exit 1 if a committed manifest no longer
//                                         matches the code
//
// Needs the root and policy/ dependencies installed. CI chains
// code -> manifest (--check) -> lock (truecopy verify), so a change to a tool's
// name, description or schema fails until the manifest is regenerated and re-pinned.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildSessionServer } from '../mcp-server.mjs';
import { createPicketServer } from '../policy/src/mcp.mjs';

const root = new URL('../', import.meta.url);

const noConnect = () => { throw new Error('dump-tools lists tools only; it never connects a browser'); };

const SERVERS = [
  { name: 'browser-bridge', file: 'mcp/browser-bridge.json', build: () => buildSessionServer({}, noConnect, () => {}) },
  { name: 'fieldpass', file: 'mcp/fieldpass.json', build: () => createPicketServer({ judge: null, cdp: null }).server },
];

async function listTools(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'dump-tools', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  try {
    const { tools } = await client.listTools();
    return tools.slice().sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await client.close();
  }
}

const check = process.argv.includes('--check');
let stale = 0;
for (const s of SERVERS) {
  const tools = await listTools(s.build());
  // Non-ASCII is written as \u escapes: the descriptions carry em dashes, which
  // check-hygiene.mjs rejects on added lines. The parsed JSON is unchanged.
  const rendered = JSON.stringify({ name: s.name, tools }, null, 2)
    .replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) + '\n';
  const path = fileURLToPath(new URL(s.file, root));
  if (check) {
    let committed = '';
    try { committed = readFileSync(path, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing counts as stale */ }
    if (committed === rendered) {
      console.log(`${s.file} matches the ${s.name} tool surface (${tools.length} tools)`);
    } else {
      stale++;
      console.error(`${s.file} is stale: the ${s.name} tool surface changed.`);
    }
  } else {
    mkdirSync(fileURLToPath(new URL('mcp/', root)), { recursive: true });
    writeFileSync(path, rendered);
    console.log(`wrote ${s.file} (${tools.length} tools)`);
  }
}
if (stale) {
  console.error('Regenerate with `node scripts/dump-tools.mjs`, review the diff, and re-pin with `truecopy add mcp/<name>.json`.');
  process.exit(1);
}
