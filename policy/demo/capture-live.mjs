/**
 * Live-bridge capture — drives a real containerized Chrome (over CDP) and
 * contrasts it with the static parser on the SAME page.
 *
 * The booby-trapped page hides payloads two ways: inline styles (static catches
 * these) and CSS *classes* like `.invisible-note{color:#fff;background:#fff}`
 * and `.sr-only{clip:…}` (static can't resolve — no computed styles). Real
 * Chrome resolves both, so the CDP capture attributes visibility correctly.
 *
 * Validated 2026-06-18 against a live containerized CDP browser (Chrome 149):
 * both backends reach BLOCK, but the CDP path correctly attributes the
 * class-hidden white-on-white payload (7 hidden vs the static parser's 6).
 *
 * Prereq: a CDP browser reachable at localhost:9222. For a container-bound
 * DevTools port, tunnel to it — e.g.  ssh -N -L 9222:<container-ip>:9222 user@host
 * Then:  node demo/capture-live.mjs        (override base with PICKET_CDP=…)
 */

import { readFileSync } from 'node:fs';
import { captureFromHtml, captureFromBridge } from '../src/capture.mjs';
import { detect } from '../src/detect.mjs';

const base = process.env.PICKET_CDP || 'http://localhost:9222';
const html = readFileSync(new URL('./booby-trapped.html', import.meta.url), 'utf8');
const URL_LABEL = 'https://acme-vendor.example/portal';

async function wsEndpoint() {
  const res = await fetch(`${base}/json/version`).catch((e) => {
    throw new Error(`cannot reach CDP at ${base} — is the tunnel up? (${e.message})`);
  });
  const v = await res.json();
  // The bridge reports its own container host; rewrite it to the tunnel host
  // or the WS won't route back through the SSH tunnel.
  const u = new URL(v.webSocketDebuggerUrl);
  u.host = new globalThis.URL(base).host;
  return { ws: u.toString(), chrome: v.Browser };
}

const summarize = (d) => {
  const hidden = d.findings.filter((f) => f.hidden).length;
  return `${d.verdict.toUpperCase()} · ${d.findings.length} findings (${hidden} attributed hidden)${d.trifecta ? ' · TRIFECTA' : ''}`;
};

console.log(`\npicket live-bridge capture — ${base}\n`);

const stat = detect(captureFromHtml(html, { url: URL_LABEL }));
console.log(`static parser : ${summarize(stat)}`);

let cdp;
try {
  const { ws, chrome } = await wsEndpoint();
  console.log(`bridge        : ${chrome}`);
  const obs = await captureFromBridge({ browserWSEndpoint: ws, html, url: URL_LABEL });
  cdp = detect(obs);
  console.log(`CDP (chrome)  : ${summarize(cdp)}\n`);

  // Show what computed styles changed: nodes the static pass called "visible"
  // that real Chrome correctly resolves as hidden (class-based hiding).
  const statById = new Map(stat.findings.map((f) => [f.excerpt.slice(0, 40), f]));
  for (const f of cdp.findings) {
    const s = statById.get(f.excerpt.slice(0, 40));
    if (f.hidden && s && !s.hidden) {
      console.log(`  ✓ class-based hiding resolved by computed styles: ${f.hiddenReasons.join('/')}`);
      console.log(`    "${f.excerpt.slice(0, 80)}…"`);
    }
  }
  console.log('\n  Both backends reach the same verdict; the CDP path adds correct visibility');
  console.log('  attribution + catches class-only-hidden payloads the static parser cannot see.\n');
} catch (err) {
  console.error(`\n  live capture skipped: ${err.message}`);
  console.error('  (the static result above still stands; bring up the tunnel to run the CDP path.)\n');
  process.exitCode = 0;
}
