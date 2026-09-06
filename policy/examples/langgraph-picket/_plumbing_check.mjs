// Layer test: the same picket-mcp wiring exercised with a RAW MCP client — no
// LangGraph. If this passes and the graph fails, the problem is in the graph;
// if this fails, the problem is in the picket wiring. Run: node _plumbing_check.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const PICKET_MCP = process.env.PICKET_MCP || here('../../bin/picket-mcp.mjs');
const PAGE = readFileSync(here('./hostile-invoice.html'), 'utf8');

const client = new Client({ name: 'plumbing-check', version: '0.0.0' });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [PICKET_MCP],
  env: { ...process.env, PICKET_ALLOWLIST: 'acme.example', PICKET_CDP: '' },
  stderr: 'pipe',
}));

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log('tools:', names);

const r = await client.callTool({ name: 'picket_observe', arguments: { html: PAGE, task: 'process the acme invoice' } });
const text = r.content.map((b) => b.text).join('\n');
console.log('observe verdict line:', text.split('\n')[0]);

const ok =
  names.join(',') === 'picket_gate,picket_login,picket_observe' &&
  /BLOCK/.test(text) &&
  !/exfil\.evil\.example/.test(text) &&
  /Invoice #7/.test(text);
await client.close();
console.log(ok ? 'PLUMBING_PASS' : 'PLUMBING_FAIL');
process.exit(ok ? 0 : 1);
