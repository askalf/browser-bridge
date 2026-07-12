// Fuzz the UA pool — parseChromeMajor runs over `chromium --version` output
// and pickUa's session id comes straight from the client's ?session= query
// parameter, so both see input the bridge doesn't control. Contracts:
// parseChromeMajor returns a non-negative integer or null (never throws);
// buildUaPool always yields one fully-substituted UA per template; pickUa
// never throws on a hostile session id, always returns a pool member, and is
// deterministic for the same session (the stable-fingerprint guarantee).
import {
  parseChromeMajor,
  buildUaPool,
  pickUa,
  FALLBACK_CHROME_MAJOR,
  UA_TEMPLATES,
} from '../ua.mjs';

export function fuzz(data) {
  const s = data.toString('utf8');

  const major = parseChromeMajor(s);
  if (major !== null && (!Number.isInteger(major) || major < 0)) {
    throw new Error(`parseChromeMajor returned a malformed major: ${major}`);
  }

  const pool = buildUaPool(major ?? FALLBACK_CHROME_MAJOR);
  if (
    !Array.isArray(pool) ||
    pool.length !== UA_TEMPLATES.length ||
    pool.some((u) => typeof u !== 'string' || u.includes('{M}'))
  ) {
    throw new Error('buildUaPool produced a malformed pool');
  }

  const ua = pickUa(pool, s, 'fallback-seed');
  if (!pool.includes(ua)) throw new Error('pickUa returned a UA outside the pool');
  if (s.length > 0 && pickUa(pool, s, 'other-seed') !== ua) {
    throw new Error('pickUa is not deterministic for the same session id');
  }
}
