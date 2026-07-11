/**
 * User-agent pool for the stealth browser.
 *
 * The advertised Chrome major is derived from the ACTUAL installed Chromium at
 * startup — not hardcoded — so it can never drift from the browser that renders
 * the page. A UA whose major disagrees with the real engine is itself a
 * high-signal bot tell, and a hardcoded pool reintroduces that mismatch every
 * time the image's Chromium moves (the pool had been pinned to Chrome 132 while
 * the image ships Debian's current Chromium). Deriving it structurally removes
 * the rot instead of deferring it to the next manual bump.
 *
 * Everything here is pure (or dependency-injected), so it's unit-tested without
 * a real Chromium.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

// {M} is replaced with the detected Chromium major. Latest Chrome stable
// across the major desktop and mobile platforms (Chrome on iOS reports CriOS).
export const UA_TEMPLATES = [
  // Windows 10
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36',
  // macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36',
  // Linux
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Safari/537.36',
  // Android (Pixel 8)
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{M}.0.0.0 Mobile Safari/537.36',
  // iOS (Chrome on iPhone reports as CriOS)
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/{M}.0.0.0 Mobile/15E148 Safari/604.1',
];

// Used ONLY when `chromium --version` can't be read or parsed — launch must
// never fail over UA detection. Keep roughly aligned with the Debian stable
// Chromium the image installs so the fallback isn't itself a stale mismatch.
export const FALLBACK_CHROME_MAJOR = 140;

/** Extract the Chrome/Chromium major from a `--version` string. Pure. Returns null if unparseable. */
export function parseChromeMajor(versionOutput) {
  const m = /(\d+)\.\d+\.\d+/.exec(String(versionOutput ?? ''));
  return m ? parseInt(m[1], 10) : null;
}

/** Build the concrete UA pool for a given Chrome major. Pure. */
export function buildUaPool(major) {
  const M = String(major);
  return UA_TEMPLATES.map((t) => t.split('{M}').join(M));
}

/**
 * Detect the installed Chromium major by running `<chromePath> --version`
 * (e.g. "Chromium 140.0.7339.185 built on Debian ..."). `exec` is injectable
 * for tests. Falls back to FALLBACK_CHROME_MAJOR if the binary can't be run or
 * its output can't be parsed.
 */
export function detectChromeMajor(chromePath, exec = execFileSync) {
  try {
    const out = exec(chromePath, ['--version'], { timeout: 5000 }).toString();
    return parseChromeMajor(out) ?? FALLBACK_CHROME_MAJOR;
  } catch {
    return FALLBACK_CHROME_MAJOR;
  }
}

/**
 * Deterministically pick a UA from `pool` for a session: the same session id
 * keeps a stable fingerprint across reconnects, while different sessions spread
 * across the pool so one UA doesn't dominate a target's logs. Pure given
 * (pool, sessionId, fallbackSeed); `fallbackSeed` is used when no session id.
 */
export function pickUa(pool, sessionId, fallbackSeed) {
  const seed = sessionId && sessionId.length > 0 ? sessionId : fallbackSeed;
  const digest = createHash('sha256').update(seed).digest();
  // A 32-bit slice is plenty of entropy for a small pool; modulo bias is far
  // below anything observable.
  const idx = digest.readUInt32BE(0) % pool.length;
  return pool[idx];
}
