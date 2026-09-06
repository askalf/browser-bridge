#!/usr/bin/env node
/**
 * picket CLI — scan a page (HTML file or live URL) for indirect prompt
 * injection and print a verdict.
 *
 *   picket scan ./page.html
 *   picket scan https://example.com                       (static fetch)
 *   picket scan https://example.com --browser http://127.0.0.1:9222
 *   picket scan ./page.html --json
 *
 * A URL with no CDP browser configured is fetched and parsed statically.
 * That path cannot resolve computed styles, so CSS-based hiding
 * (white-on-white, offscreen, class-driven display:none) is not detected
 * as hidden — inline styles and structural hiding still are. Pass
 * --browser for full fidelity; the header line always says which was used.
 *
 * Exit codes (CI-friendly, same spirit as canon): 0 allow/flag · 1 quarantine · 2 block.
 */

import { readFileSync } from 'node:fs';
import { detect } from '../src/detect.mjs';
import { captureFromHtml, captureFromBridge } from '../src/capture.mjs';
import { buildSafeObservation } from '../src/neutralize.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const target = argv[1];
const flag = (n) => { const i = argv.indexOf(n); return i !== -1 ? (argv[i + 1] || true) : undefined; };
const has = (n) => argv.includes(n);

if (cmd !== 'scan' || !target) {
  console.log('usage: picket scan <file.html|url> [--browser <cdp-url>] [--json] [--safe]');
  process.exit(64);
}

const EXIT = { allow: 0, flag: 0, quarantine: 1, block: 2 };
const isUrl = /^https?:\/\//i.test(target);
const browserURL = flag('--browser') || process.env.PICKET_BROWSER_URL || process.env.PICKET_CDP;

let obs;
if (isUrl && browserURL) {
  obs = await captureFromBridge({ url: target, browserURL });
} else if (isUrl) {
  // No CDP endpoint: fetch and parse statically rather than handing
  // puppeteer an undefined endpoint (which threw a bare assert stack).
  let res;
  try {
    res = await fetch(target, { redirect: 'follow', headers: { 'user-agent': 'picket-scan' } });
  } catch (e) {
    console.error(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(65);
  }
  if (!res.ok) {
    console.error(`fetch failed: HTTP ${res.status} ${res.statusText}`);
    process.exit(65);
  }
  obs = captureFromHtml(await res.text(), { url: target });
} else {
  obs = captureFromHtml(readFileSync(target, 'utf8'), { url: flag('--url') || 'file://' + target });
}

const d = detect(obs);

const staticOnUrl = isUrl && !browserURL;

if (has('--json')) {
  const out = { target, capturedBy: obs.capturedBy, verdict: d.verdict, trifecta: d.trifecta, summary: d.summary, findings: d.findings };
  if (has('--safe')) out.safeView = buildSafeObservation(obs, d).text;
  console.log(JSON.stringify(out, null, 2));
  process.exit(EXIT[d.verdict] ?? 0);
}

const ICON = { critical: '🟥', high: '🟧', medium: '🟨', low: '🟦', info: '⬜' };
console.log(`\npicket scan — ${target}`);
console.log(`captured: ${obs.capturedBy} · nodes: ${obs.nodes.length}`);
if (staticOnUrl) {
  console.log('note: static fetch — CSS-based hiding is not resolved. Pass --browser <cdp-url> for computed styles.');
}
console.log(`\nVERDICT: ${d.verdict.toUpperCase()}${d.trifecta ? '  ⚠ LETHAL TRIFECTA' : ''}`);
console.log(`${d.summary}\n`);
for (const f of d.findings) {
  console.log(`${ICON[f.severity]} ${f.severity.padEnd(8)} [${f.action}] ${f.hidden ? `hidden(${f.hiddenReasons.join('/')})` : 'visible'} ${f.source}`);
  console.log(`   ${f.categories.join(', ')}`);
  console.log(`   "${f.excerpt}"${f.sinks.length ? `  → ${f.sinks.join(', ')}` : ''}\n`);
}
if (has('--safe')) {
  console.log('— safe view handed to the model —');
  console.log(buildSafeObservation(obs, d).text);
}
process.exit(EXIT[d.verdict] ?? 0);
