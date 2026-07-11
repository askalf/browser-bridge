/**
 * stealth-score — drive the bridge through a battery of the bot-detection
 * vectors that sannysoft (bot.sannysoft.com) and CreepJS probe, count how many
 * the bridge's stealth passes, and emit a shields.io endpoint badge.
 *
 * It connects as an ordinary CDP client — so it measures the stealth an actual
 * consumer of the bridge gets, not some privileged in-process view — opens a
 * real document (evasions inject on document creation), and runs the checks
 * in-page. Deterministic and network-free: every vector is evaluated locally,
 * so the score is a stable regression signal that trips when a puppeteer-extra
 * or Chromium bump changes behaviour.
 *
 *   node stealth-score.mjs --cdp http://127.0.0.1:9222 --out stealth.json
 *
 * Exit code is non-zero when passed < floor (BRIDGE_STEALTH_FLOOR, default
 * total-1), so it doubles as a CI gate.
 */

import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const CDP_URL = arg('cdp', process.env.BRIDGE_CDP_URL || 'http://127.0.0.1:9222');
const OUT = arg('out', process.env.BRIDGE_STEALTH_OUT || 'stealth.json');

// The battery. Each check is deterministic and evaluated in the page after a
// real document is loaded so the full stealth evasion set is active. `webgl`
// is reported for visibility but NOT scored — it depends on the CI runner's
// GPU/SwiftShader and would add noise to a regression gate.
const PROBE = `(async () => {
  const results = [];
  const add = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail: String(detail) });

  add('webdriver_false', navigator.webdriver === false, 'navigator.webdriver=' + navigator.webdriver);
  add('no_headless_ua', !/headless/i.test(navigator.userAgent), navigator.userAgent);
  add('plugins_present', navigator.plugins.length > 0, 'count=' + navigator.plugins.length);
  add('plugins_is_pluginarray', Object.prototype.toString.call(navigator.plugins) === '[object PluginArray]', Object.prototype.toString.call(navigator.plugins));
  add('mimetypes_present', navigator.mimeTypes.length > 0, 'count=' + navigator.mimeTypes.length);
  add('languages_present', Array.isArray(navigator.languages) && navigator.languages.length > 0, JSON.stringify(navigator.languages));
  add('window_chrome', typeof window.chrome === 'object' && window.chrome !== null, 'typeof=' + typeof window.chrome);
  add('vendor_google', navigator.vendor === 'Google Inc.', 'vendor=' + navigator.vendor);
  add('hardware_concurrency', typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0, 'hc=' + navigator.hardwareConcurrency);
  add('outer_dimensions', window.outerWidth > 0 && window.outerHeight > 0, window.outerWidth + 'x' + window.outerHeight);
  add('no_automation_globals', !(window.__nightmare || window._phantom || window.callPhantom || window.domAutomation || window.domAutomationController || window.__driver_evaluate || window.__webdriver_evaluate || window.__selenium_evaluate), 'checked common driver globals');

  // iframe.contentWindow.chrome — a real Chrome exposes window.chrome inside
  // same-origin iframes; unpatched headless does not.
  try {
    const f = document.createElement('iframe');
    f.style.display = 'none';
    document.body.appendChild(f);
    add('iframe_contentwindow_chrome', !!(f.contentWindow && f.contentWindow.chrome), 'iframe chrome present=' + !!(f.contentWindow && f.contentWindow.chrome));
    f.remove();
  } catch (e) { add('iframe_contentwindow_chrome', false, 'threw: ' + e.message); }

  // The classic headless Notification/permissions mismatch: unpatched, the
  // Permissions API reports 'denied' while Notification.permission is 'default'.
  try {
    const status = await navigator.permissions.query({ name: 'notifications' });
    add('permissions_consistency', !(Notification.permission === 'default' && status.state === 'denied'), 'Notification=' + Notification.permission + ', query=' + status.state);
  } catch (e) { add('permissions_consistency', false, 'query threw: ' + e.message); }

  let webgl = 'unavailable';
  try {
    const gl = document.createElement('canvas').getContext('webgl') || document.createElement('canvas').getContext('experimental-webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) webgl = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) + ' / ' + gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch {}
  return { results, webgl };
})()`;

const color = (passed, total, floor) =>
  passed === total ? 'brightgreen' : passed >= floor ? 'yellow' : 'red';

async function main() {
  const browser = await puppeteer.connect({ browserURL: CDP_URL });
  let out;
  try {
    const page = await browser.newPage();
    // Load a real (non about:blank) document so every on-new-document evasion
    // is installed before the checks run.
    await page.setContent('<!doctype html><html><head><title>stealth</title></head><body>probe</body></html>', { waitUntil: 'load' });
    out = await page.evaluate(PROBE);
    await page.close().catch(() => {});
  } finally {
    await browser.disconnect().catch(() => {});
  }

  const { results, webgl } = out;
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  const floor = parseInt(process.env.BRIDGE_STEALTH_FLOOR || String(total - 1), 10);

  for (const r of results) console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.detail}`);
  console.log(`  ----  webgl (informational)      ${webgl}`);
  console.log(`\nstealth score: ${passed}/${total} (floor ${floor})`);

  const badge = { schemaVersion: 1, label: 'stealth', message: `${passed}/${total}`, color: color(passed, total, floor) };
  fs.writeFileSync(OUT, JSON.stringify(badge, null, 2) + '\n');
  console.log(`wrote ${OUT}: ${JSON.stringify(badge)}`);

  if (passed < floor) {
    console.error(`\nFAIL: stealth score ${passed}/${total} below floor ${floor} — a stealth regression?`);
    process.exit(1);
  }
}

main().catch((err) => { console.error('stealth-score error:', err.message); process.exit(2); });
