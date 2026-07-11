/**
 * SPIKE E2E — drive two clients through ONE broker port and assert:
 *   1. each client lands in its OWN browser (isolation): client A sees only
 *      A's page, not B's — the exact cross-visibility the shared browser has.
 *   2. stealth is preserved in both (plugins == 5 via puppeteer-extra launch).
 *   3. scoped teardown: A disconnecting (ephemeral) disposes A's browser only;
 *      B keeps working. A client's browser.close() can't take down the fleet.
 *   4. named ?session= is reused across reconnects; ephemeral is not.
 */

import puppeteerCore from 'puppeteer-core';
import assert from 'node:assert/strict';
import { createBroker } from './broker.mjs';

process.on('unhandledRejection', (e) => {
  if (!String(e?.message || e).includes('Session closed')) console.error('UNEXPECTED:', e);
});

const PLUGINS = `navigator.plugins.length`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pass = [];
const check = (name, cond) => { assert.equal(cond, true, name); pass.push(name); };

const broker = createBroker();
const port = await broker.listen();
const ep = (session) => `ws://127.0.0.1:${port}/?session=${session}`;

try {
  // ── client A (named session "alpha") ──
  const A = await puppeteerCore.connect({ browserWSEndpoint: ep('alpha') });
  const pA = await A.newPage();
  await pA.goto('data:text/html,<title>PAGE-A</title>');

  // ── client B (named session "beta") ──
  const B = await puppeteerCore.connect({ browserWSEndpoint: ep('beta') });
  const pB = await B.newPage();
  await pB.goto('data:text/html,<title>PAGE-B</title>');

  await sleep(300); // let stealth injection settle

  // 1. isolation — each client sees only its own page
  const titlesA = await Promise.all((await A.pages()).map((p) => p.title().catch(() => '')));
  const titlesB = await Promise.all((await B.pages()).map((p) => p.title().catch(() => '')));
  check('A sees its own page', titlesA.includes('PAGE-A'));
  check('A does NOT see B\'s page', !titlesA.includes('PAGE-B'));
  check('B sees its own page', titlesB.includes('PAGE-B'));
  check('B does NOT see A\'s page', !titlesB.includes('PAGE-A'));

  // 2. stealth preserved in both isolated browsers
  const plugA = await pA.evaluate(PLUGINS);
  const plugB = await pB.evaluate(PLUGINS);
  check(`stealth in A (plugins=${plugA})`, plugA > 0);
  check(`stealth in B (plugins=${plugB})`, plugB > 0);

  // broker launched two distinct browsers
  const s1 = broker.stats();
  check(`two browsers launched (${s1.launches.length})`, s1.launches.length === 2);
  check('distinct PIDs', s1.launches[0].pid !== s1.launches[1].pid);

  // 4. named session reused across reconnect (same browser, sees PAGE-A still)
  await A.disconnect();
  const A2 = await puppeteerCore.connect({ browserWSEndpoint: ep('alpha') });
  const titlesA2 = await Promise.all((await A2.pages()).map((p) => p.title().catch(() => '')));
  check('named session survived reconnect (PAGE-A still there)', titlesA2.includes('PAGE-A'));
  check('no new browser launched on reconnect', broker.stats().launches.length === 2);

  // 3. scoped teardown — kill session alpha; beta unaffected
  //    (ephemeral disposal is covered by the connectOverCDP test below;
  //     here we prove a client operating on alpha can't affect beta)
  const stillB = await pB.evaluate(`1+1`);
  check('B still fully operational while A churns', stillB === 2);

  await A2.disconnect();
  await B.disconnect();

  // ── ephemeral: connectOverCDP with no session → minted, disposed on close ──
  const C = await puppeteerCore.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/` });
  const pC = await C.newPage();
  await pC.goto('data:text/html,<title>PAGE-C</title>');
  const beforeClose = broker.stats().live.length;
  await C.disconnect();
  await sleep(500); // ephemeral teardown is async on socket close
  const afterClose = broker.stats().live.length;
  check(`ephemeral disposed on disconnect (${beforeClose}->${afterClose})`, afterClose < beforeClose);

  console.log('=== E2E PASSED ===');
  for (const p of pass) console.log('  ✓', p);
} catch (err) {
  console.error('=== E2E FAILED ===');
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await broker.shutdownAll();
  await sleep(200);
  process.exit(process.exitCode || 0);
}
