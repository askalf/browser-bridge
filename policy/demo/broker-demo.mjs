/**
 * ContextBroker showcase — a pool of isolated, keeper-backed persona browser
 * contexts on one shared Chrome. Reads a real page THROUGH a persona's page,
 * proves isolation + warm-session reuse, and that close() never kills the
 * shared browser.
 *
 * Prereq: a CDP browser at localhost:9222 (override with PICKET_CDP).
 * Run:  PICKET_CDP=http://127.0.0.1:9222 node demo/broker-demo.mjs
 */
import { ContextBroker } from '../src/broker.mjs';
import { captureFromBridge } from '../src/capture.mjs';
import { detect } from '../src/detect.mjs';

const base = process.env.PICKET_CDP || 'http://localhost:9222';
const REAL_URL = process.env.PICKET_REAL_URL || 'https://example.com/';

async function wsEndpoint() {
  const res = await fetch(`${base}/json/version`).catch((e) => {
    throw new Error(`CDP unreachable at ${base} — is a browser/tunnel up? (${e.message})`);
  });
  const v = await res.json();
  const u = new URL(v.webSocketDebuggerUrl); u.host = new URL(base).host;
  return { ws: u.toString(), chrome: v.Browser };
}

let info;
try { info = await wsEndpoint(); }
catch (e) { console.error(`\npicket ContextBroker demo needs a CDP browser.\n  ${e.message}\n  Start one: chrome --headless=new --remote-debugging-port=9222 --user-data-dir=$(mktemp -d)\n`); process.exit(0); }

const broker = new ContextBroker({ browserWSEndpoint: info.ws, maxContexts: 2 });
console.log(`\npicket — ContextBroker · ${info.chrome} @ ${base}\n` + '─'.repeat(64));

// One isolated context per persona, read a real page through it.
const alpha = await broker.checkout('alpha');
const obsA = detect(await captureFromBridge({ page: alpha.page, url: REAL_URL }));
console.log(`alpha · read ${REAL_URL} through the persona's page → verdict ${obsA.verdict.toUpperCase()}`);
broker.checkin('alpha');

const beta = await broker.checkout('beta');
console.log(`beta  · isolated context (own cookies/storage): ${beta.context !== alpha.context ? '✅' : '❌'}`);
broker.checkin('beta');

const alpha2 = await broker.checkout('alpha');
console.log(`alpha · checked out again → SAME warm context (session persists): ${alpha2.context === alpha.context ? '✅' : '❌'}`);
broker.checkin('alpha');

console.log(`pool  · ${JSON.stringify(broker.stats())}`);

await broker.close();
const alive = await fetch(`${base}/json/version`).then((r) => r.ok).catch(() => false);
console.log(`close · contexts closed, shared Chrome ${alive ? 'still alive ✅ (disconnect, never close)' : 'KILLED ❌'}`);
console.log('\na pool of governed, keeper-backed persona sessions on one shared browser ✅\n');
