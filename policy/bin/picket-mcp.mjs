#!/usr/bin/env node
/**
 * picket MCP server. Two transports, same three tools:
 *
 * stdio (default) — add to an MCP client config, e.g. Claude Desktop /
 * Claude Code `.mcp.json`:
 *
 *   {
 *     "mcpServers": {
 *       "picket": {
 *         "command": "npx",
 *         "args": ["-y", "@askalf/fieldpass", "picket-mcp"],
 *         "env": {
 *           "PICKET_ALLOWLIST": "example.com,acme.example",
 *           "PICKET_CDP": "http://127.0.0.1:9222",
 *           "PICKET_JUDGE": "dario"
 *         }
 *       }
 *     }
 *   }
 *
 * Streamable HTTP — `picket-mcp --http [--port 7425]` serves the same tools
 * as a URL-type MCP server for clients that can't spawn a process: the
 * Claude API MCP connector, Managed Agents, remote agent runtimes.
 * Binds 127.0.0.1 by default; set PICKET_MCP_TOKEN before exposing it wider.
 *
 * Env: PICKET_ALLOWLIST (comma-separated host suffixes), PICKET_CDP (live URL
 * fetches; omit for html-only), PICKET_JUDGE ("dario" | "claude" | unset),
 * PICKET_TASK (default trusted task). HTTP mode (`--http` or PICKET_MCP_PORT):
 * PICKET_MCP_PORT / PICKET_MCP_HOST / PICKET_MCP_PATH / PICKET_MCP_TOKEN.
 *
 * stdout is the MCP channel in stdio mode — all human-readable logging goes
 * to stderr in both modes.
 */
import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createPicketServer } from '../src/mcp.mjs';
import { startPicketHttpServer } from '../src/mcp-http.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const allowlist = (process.env.PICKET_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

const opts = {
  version: pkg.version,
  allowlist,
  task: process.env.PICKET_TASK || '',
  judge: process.env.PICKET_JUDGE || null,
  cdp: process.env.PICKET_CDP || null,
};

const summary =
  `allowlist=[${allowlist.join(', ') || '∗ (open)'}] · ` +
  `cdp=${process.env.PICKET_CDP || 'none — html-only'} · ` +
  `judge=${process.env.PICKET_JUDGE || 'off'}`;

if (flag('http') || process.env.PICKET_MCP_PORT) {
  const portArg = flag('port');
  const { url } = await startPicketHttpServer({
    ...opts,
    port: typeof portArg === 'string' ? Number(portArg) : undefined,
    host: typeof flag('host') === 'string' ? flag('host') : undefined,
    path: typeof flag('path') === 'string' ? flag('path') : undefined,
  });
  console.error(
    `picket MCP server ready (v${pkg.version}) · streamable-http ${url} · ` +
    `auth=${process.env.PICKET_MCP_TOKEN ? 'bearer' : 'OFF (loopback only!)'} · ${summary}`
  );
} else {
  const { server } = createPicketServer(opts);
  await server.connect(new StdioServerTransport());
  console.error(`picket MCP server ready (v${pkg.version}) · stdio · ${summary}`);
}
