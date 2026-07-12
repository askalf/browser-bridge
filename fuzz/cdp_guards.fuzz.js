// Fuzz the CDP proxy's security seams — the pure request guards every HTTP
// request and WebSocket upgrade passes through before anything reaches
// Chromium. Contracts pinned:
//   - hostIsIpOrLocalhost (the DNS-rebinding gate) never throws, and never
//     answers true for a Host whose hostname is a DNS name — that would let
//     an unauthenticated rebinding attack through.
//   - strippedPath never lets a ?token= secret survive into the forwarded
//     path (it would land in Chromium's logs otherwise).
//   - forwardedHeaderLines never leaks Authorization / X-Bridge-Token
//     upstream and always rewrites Host to the loopback target.
//   - presentedToken never throws and only ever returns a string or null.
import net from 'node:net';
import {
  presentedToken,
  hostIsIpOrLocalhost,
  forwardedHeaderLines,
  strippedPath,
} from '../cdp-proxy.mjs';

export function fuzz(data) {
  const s = data.toString('utf8');

  const gate = hostIsIpOrLocalhost(s);
  if (typeof gate !== 'boolean') throw new Error('rebinding gate returned a non-boolean');
  if (gate && s) {
    // Mirror check: if the gate passed a non-empty Host, its hostname must
    // genuinely be an IP literal or localhost.
    let hostname = null;
    try { hostname = new URL(`http://${s}`).hostname; } catch {}
    if (hostname === null) {
      throw new Error(`rebinding gate accepted an unparseable Host: ${JSON.stringify(s.slice(0, 80))}`);
    }
    const bare = hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) === 0 && bare.toLowerCase() !== 'localhost') {
      throw new Error(`rebinding gate accepted a DNS hostname: ${JSON.stringify(s.slice(0, 80))}`);
    }
  }

  let url = null;
  try { url = new URL(s, 'http://bridge.invalid'); } catch {}
  if (url) {
    const path = strippedPath(url);
    if (typeof path !== 'string') throw new Error('strippedPath returned a non-string');
    // Check the query side directly — the proxy uses `path` as an HTTP
    // request-target, never re-parses it as a URL (and a `//`-prefixed
    // pathname is protocol-relative to new URL(), which would throw here).
    const q = path.indexOf('?');
    if (q !== -1 && new URLSearchParams(path.slice(q + 1)).has('token')) {
      throw new Error('?token= secret survived strippedPath');
    }
  }

  // A synthesized request carrying the secret in every position, plus one
  // fuzz-derived (sanitized) header so hostile values ride along.
  const fuzzName = `X-F-${s.slice(0, 24).replace(/[^A-Za-z0-9-]/g, '') || 'x'}`;
  const req = {
    headers: {
      authorization: `Bearer ${s.slice(0, 32)}`,
      'x-bridge-token': s,
      host: s.slice(0, 64),
    },
    rawHeaders: [
      'Authorization', `Bearer ${s.slice(0, 32)}`,
      'X-Bridge-Token', s,
      'Host', s.slice(0, 64),
      fuzzName, s,
    ],
  };

  if (url) {
    const t = presentedToken(req, url);
    if (t !== null && typeof t !== 'string') throw new Error('presentedToken returned a non-string');
  }

  const target = '127.0.0.1:9333';
  for (const line of forwardedHeaderLines(req, target)) {
    const low = line.toLowerCase();
    if (low.startsWith('authorization:') || low.startsWith('x-bridge-token:')) {
      throw new Error('secret header leaked into the forwarded block');
    }
    if (low.startsWith('host:') && !line.endsWith(target)) {
      throw new Error('Host line not rewritten to the loopback target');
    }
  }
}
