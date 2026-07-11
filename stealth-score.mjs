/**
 * Stealth score — the canonical bot-detection signal set the puppeteer-extra
 * stealth plugin is configured to defeat (see ALL_EVASIONS in launch.mjs),
 * evaluated live in the bridge's browser. The score is the fraction of those
 * signals that read as a real, non-automated Chrome.
 *
 * `stealthProbe` runs IN THE BROWSER (via page.evaluate) — it is self-contained
 * and touches only browser globals, so it is not unit-tested here; the live CI
 * run exercises it. Everything else is pure and unit-tested: given a results
 * array, the scoring, colouring, and shields badge JSON are deterministic.
 */

// Gate: fail the scheduled run (and notify) only on a genuinely broken score —
// i.e. red. Kept below the green band so a couple of environment-specific check
// misses (e.g. WebGL under --disable-gpu) show yellow without false-failing;
// a real stealth regression (5+ of the signals reverting) still trips it.
export const FLOOR = 0.70;

/**
 * In-browser probe. MUST be self-contained (no closure/module refs) — puppeteer
 * serializes it and runs it in the page. Returns [{ name, pass, detail }].
 * async because navigator.permissions.query is a promise.
 */
export async function stealthProbe() {
  const results = [];
  const add = (name, pass, detail) => results.push({ name, pass: !!pass, detail: detail ?? '' });
  const nav = navigator;

  // 1. navigator.webdriver must not be true — the single highest-signal tell.
  add('webdriver-hidden', nav.webdriver !== true, `webdriver=${String(nav.webdriver)}`);

  // 2-3. window.chrome runtime object + chrome.app (headless drops these).
  add('chrome-object', typeof window.chrome === 'object' && window.chrome !== null);
  add('chrome-app', !!(window.chrome && window.chrome.app));

  // 4-6. plugins / mimeTypes / languages are non-empty on a real desktop Chrome.
  add('plugins-nonempty', nav.plugins && nav.plugins.length > 0, `len=${nav.plugins ? nav.plugins.length : 0}`);
  add('mimetypes-nonempty', nav.mimeTypes && nav.mimeTypes.length > 0, `len=${nav.mimeTypes ? nav.mimeTypes.length : 0}`);
  add('languages-nonempty', Array.isArray(nav.languages) && nav.languages.length > 0, (nav.languages || []).join(','));

  // 7. UA must not advertise HeadlessChrome.
  add('ua-not-headless', !/headlesschrome/i.test(nav.userAgent), nav.userAgent);

  // 8. vendor is 'Google Inc.' on real Chrome.
  add('vendor-google', nav.vendor === 'Google Inc.', `vendor=${nav.vendor}`);

  // 9. platform is a non-empty string.
  add('platform-set', typeof nav.platform === 'string' && nav.platform.length > 0, `platform=${nav.platform}`);

  // 10. hardwareConcurrency is a positive number.
  add('hardware-concurrency', typeof nav.hardwareConcurrency === 'number' && nav.hardwareConcurrency > 0, `n=${nav.hardwareConcurrency}`);

  // 11. Real window has non-zero outer dimensions (headless reports 0).
  add('outer-dimensions', window.outerWidth > 0 && window.outerHeight > 0, `${window.outerWidth}x${window.outerHeight}`);

  // 12. Notification permission consistency — the classic headless mismatch is
  // Notification.permission === 'denied' while permissions.query() says 'prompt'.
  try {
    const perm = await nav.permissions.query({ name: 'notifications' });
    const mismatch = typeof Notification !== 'undefined' && Notification.permission === 'denied' && perm.state === 'prompt';
    add('permissions-consistent', !mismatch, `notif=${typeof Notification !== 'undefined' ? Notification.permission : 'n/a'}, query=${perm.state}`);
  } catch (e) {
    add('permissions-consistent', false, `query threw: ${String(e && e.message || e)}`);
  }

  // 13. WebGL must not report a software renderer (SwiftShader/llvmpipe/Mesa) —
  // that's a headless/container tell the webgl.vendor evasion masks.
  try {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    const software = /swiftshader|llvmpipe|software|mesa/i.test(renderer);
    add('webgl-not-software', !!renderer && !software, `renderer=${renderer || 'n/a'}`);
  } catch (e) {
    add('webgl-not-software', false, `webgl threw: ${String(e && e.message || e)}`);
  }

  // 14. userAgentData (if present) brands must not include Headless.
  try {
    const brands = (nav.userAgentData && nav.userAgentData.brands) || [];
    const headless = brands.some((b) => /headless/i.test(b.brand || ''));
    add('uadata-not-headless', !headless, brands.map((b) => b.brand).join(','));
  } catch (e) {
    add('uadata-not-headless', true, 'no userAgentData');
  }

  return results;
}

// ── pure scoring (unit-tested) ──────────────────────────────────────

/** Reduce a results array to counts + ratio. Pure. */
export function computeScore(results) {
  const list = Array.isArray(results) ? results : [];
  const total = list.length;
  const passed = list.filter((r) => r && r.pass).length;
  const ratio = total ? passed / total : 0;
  return { passed, total, ratio, pct: Math.round(ratio * 100) };
}

/** shields.io colour for a pass ratio. Fixed bands (independent of the gate FLOOR). Pure. */
export function scoreColor(ratio) {
  if (ratio >= 0.95) return 'brightgreen';
  if (ratio >= 0.85) return 'green';
  if (ratio >= 0.70) return 'yellow';
  return 'red';
}

/** shields.io endpoint badge JSON for a score. Pure. */
export function badgeJson(score) {
  const { passed, total, pct, ratio } = score;
  return {
    schemaVersion: 1,
    label: 'stealth',
    message: total ? `${pct}% · ${passed}/${total}` : 'unknown',
    color: total ? scoreColor(ratio) : 'lightgrey',
  };
}

/** Names of the failing checks, for the report + gate message. Pure. */
export function failingChecks(results) {
  return (Array.isArray(results) ? results : []).filter((r) => r && !r.pass).map((r) => r.name);
}

/** Render the human STEALTH.md report. Pure. */
export function renderReport({ score, results, creepTrust, ua, chromiumMajor, generatedAt }) {
  const rows = (results || []).map((r) => `| ${r.pass ? '✅' : '❌'} | \`${r.name}\` | ${r.detail || ''} |`).join('\n');
  const fails = failingChecks(results);
  return [
    '# browser-bridge — stealth watch',
    '',
    `**Score: ${score.pct}% (${score.passed}/${score.total})** — canonical bot-detection signals defeated, evaluated live in the bridge browser on bot.sannysoft.com.`,
    creepTrust ? `\nCreepJS trust score (informational): **${creepTrust}**.` : '\nCreepJS trust score: n/a (best-effort read failed).',
    '',
    `- Chromium major: ${chromiumMajor ?? 'n/a'}`,
    `- User-Agent: \`${ua ?? 'n/a'}\``,
    `- Generated: ${generatedAt ?? 'n/a'}`,
    fails.length ? `- **Failing: ${fails.join(', ')}**` : '- All checks passed.',
    '',
    '| | check | detail |',
    '|---|---|---|',
    rows,
    '',
  ].join('\n');
}
