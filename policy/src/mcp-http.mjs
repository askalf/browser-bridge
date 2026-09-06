/**
 * picket MCP server over Streamable HTTP — the same three governed tools
 * (picket_observe / picket_gate / picket_login) served as a URL-type MCP
 * server, so clients that can't spawn a stdio process can still go through
 * the firewall: the Claude API server-side MCP connector, Managed Agents,
 * and any remote agent runtime.
 *
 * Shape: one node:http server, MCP at a single path (default /mcp), spec
 * session management (POST initialize → mcp-session-id header; GET opens the
 * SSE stream; DELETE ends the session). Each session gets its own McpServer +
 * transport, but ALL sessions share ONE GovernedBrowser — the judge's verdict
 * cache and keeper leases persist across sessions, same as stdio.
 *
 * Security posture (this is a security tool; the HTTP surface holds the line):
 *   - binds 127.0.0.1 by default — exposing it is an explicit choice
 *   - REFUSES a non-loopback bind without a bearer token (that would be an open,
 *     unauthenticated governed browser); override with allowInsecure /
 *     PICKET_MCP_ALLOW_INSECURE=1 only when fronted by other auth
 *   - DNS-rebinding protection on loopback binds (Host-header allowlist)
 *   - optional bearer token (PICKET_MCP_TOKEN) checked in constant time;
 *     set one whenever the server is reachable beyond localhost
 *   - withheld excerpts never cross the wire — that guarantee lives in
 *     src/mcp.mjs and is transport-independent
 */

import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createPicketServer } from './mcp.mjs';
import { GovernedBrowser } from './govern.mjs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1']);

/** Constant-time bearer-token check — length leak only, never content. */
function tokenMatches(presented, expected) {
  const a = Buffer.from(presented || '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Start the picket MCP server over Streamable HTTP.
 *
 * @param {Object} [opts]  everything createPicketServer takes, plus:
 * @param {number} [opts.port]  listen port (0 = ephemeral; default 7425 — PICK on a phone pad)
 * @param {string} [opts.host]  bind address (default 127.0.0.1)
 * @param {string} [opts.path]  MCP endpoint path (default /mcp)
 * @param {string} [opts.token] bearer token; when set, every MCP request must
 *   carry `Authorization: Bearer <token>` (also PICKET_MCP_TOKEN)
 * @param {string[]} [opts.allowedHosts] extra Host-header values to accept
 *   (DNS-rebinding allowlist); loopback forms for the bound port are automatic
 * @returns {Promise<{ url, port, picket, sessionCount, close }>}
 */
export async function startPicketHttpServer(opts = {}) {
  const host = opts.host ?? process.env.PICKET_MCP_HOST ?? '127.0.0.1';
  const path = opts.path ?? process.env.PICKET_MCP_PATH ?? '/mcp';
  const token = opts.token ?? process.env.PICKET_MCP_TOKEN ?? null;
  const port = opts.port ?? (process.env.PICKET_MCP_PORT ? Number(process.env.PICKET_MCP_PORT) : 7425);

  // Fail safe on exposure: a non-loopback bind reaches the network, where the
  // loopback-only DNS-rebinding guard no longer applies. Without a bearer token
  // that would be an OPEN, unauthenticated governed browser. Refuse it unless the
  // operator sets a token (recommended) or explicitly opts out (they front it
  // with their own auth). This is a security tool; it should not hand out an
  // unauthenticated remote surface by omission.
  const allowInsecure = opts.allowInsecure ?? process.env.PICKET_MCP_ALLOW_INSECURE === '1';
  if (!LOOPBACK.has(host) && !token && !allowInsecure) {
    throw new Error(
      `picket-mcp refuses to bind a non-loopback address (${host}) without a bearer token. ` +
      `Set PICKET_MCP_TOKEN (recommended), or pass allowInsecure:true / PICKET_MCP_ALLOW_INSECURE=1 ` +
      `to override when the endpoint is protected by other means.`,
    );
  }

  // One governed browser behind every session (see module doc).
  const picket = opts.picket ?? new GovernedBrowser({
    allowlist: opts.allowlist,
    task: opts.task,
    judge: opts.judge,
    dario: opts.dario,
    claude: opts.claude,
    llmJudge: opts.llmJudge,
    keeper: opts.keeper,
  });

  const sessions = new Map(); // sessionId → { transport, server }
  let rebindingHosts = []; // filled in once the port is known

  const httpServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

      // liveness probe — no auth, no session state, nothing sensitive
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, server: 'picket-mcp', version: opts.version || '0.0.0' });
      }
      if (url.pathname !== path) {
        return sendJson(res, 404, rpcError(-32000, `not found — MCP endpoint is ${path}`));
      }

      if (token) {
        const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!tokenMatches(presented, token)) {
          return sendJson(res, 401, rpcError(-32000, 'unauthorized: missing or bad bearer token'));
        }
      }

      const sessionId = req.headers['mcp-session-id'];
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return sendJson(res, 404, rpcError(-32001, 'unknown or expired session'));
        return session.transport.handleRequest(req, res);
      }

      // No session header: only an initialize POST may open a new session.
      if (req.method !== 'POST') {
        return sendJson(res, 400, rpcError(-32000, 'no session — POST an initialize request first'));
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableDnsRebindingProtection: rebindingHosts.length > 0,
        allowedHosts: rebindingHosts,
        onsessioninitialized: (sid) => { sessions.set(sid, { transport, server }); },
        onsessionclosed: (sid) => { sessions.delete(sid); },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      const { server } = createPicketServer({ ...opts, picket });
      await server.connect(transport);
      return transport.handleRequest(req, res);
      // A non-initialize body lands here too — the transport itself rejects it
      // with 400 per spec, so there's no session-fixation path around initialize.
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, `internal error: ${e.message}`));
      else res.end();
    }
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, resolve);
  });
  const boundPort = httpServer.address().port;

  // Host-header allowlist: on a loopback bind, only loopback Hosts for the
  // bound port are legitimate — anything else is a DNS-rebinding attempt.
  // On a non-loopback bind the Host varies by deployment; rely on the token
  // (and any caller-supplied allowlist) instead.
  rebindingHosts = LOOPBACK.has(host)
    ? [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`, ...(opts.allowedHosts || [])]
    : [...(opts.allowedHosts || [])];

  return {
    url: `http://${LOOPBACK.has(host) ? '127.0.0.1' : host}:${boundPort}${path}`,
    port: boundPort,
    picket,
    sessionCount: () => sessions.size,
    close: async () => {
      for (const { transport } of sessions.values()) await transport.close().catch(() => {});
      sessions.clear();
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}
