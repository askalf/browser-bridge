/**
 * Drive a running browser-bridge against real anti-bot detectors and score its
 * stealth. Connects over CDP like any bridge client (mcp-server.mjs uses the
 * same puppeteer.connect), loads bot.sannysoft.com, runs the canonical probe
 * (stealth-score.mjs) in the live browser, and best-effort reads CreepJS's
 * trust score. Writes badge.json + STEALTH.md to the out dir and prints one
 * result JSON line to stdout for the workflow's history + gate.
 *
 * Usage: BRIDGE_CDP_URL=http://127.0.0.1:9222 node stealth-check.mjs [outDir]
 * Exits non-zero only on a hard failure (can't connect / sannysoft won't load);
 * a low score still writes the badge so the scheduled run can publish it red.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { stealthProbe, computeScore, badgeJson, renderReport, failingChecks } from './stealth-score.mjs';

const CDP_URL = process.env.BRIDGE_CDP_URL || 'http://127.0.0.1:9222';
const TOKEN = process.env.BRIDGE_TOKEN || '';
const OUT_DIR = process.argv[2] || 'out';
const NAV_TIMEOUT_MS = 45_000;

function wsEndpoint(cdpUrl, sessionKey, token) {
  const base = cdpUrl.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const q = new URLSearchParams({ session: sessionKey });
  if (token) q.set('token', token);
  return `${base}/?${q.toString()}`;
}

/** Best-effort CreepJS trust score — informational, never fails the run. */
async function readCreepTrust(browser) {
  let page;
  try {
    page = await browser.newPage();
    await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    // CreepJS computes asynchronously; give it a beat, then scrape the trust %.
    await new Promise((r) => setTimeout(r, 12_000));
    const trust = await page.evaluate(() => {
      const text = document.body ? document.body.innerText : '';
      const m = /trust score[^0-9]*([0-9]{1,3}(?:\.[0-9]+)?)\s*%/i.exec(text);
      return m ? `${m[1]}%` : null;
    });
    return trust;
  } catch {
    return null;
  } finally {
    try { if (page) await page.close(); } catch { /* gone */ }
  }
}

async function main() {
  const browser = await puppeteer.connect({ browserWSEndpoint: wsEndpoint(CDP_URL, 'stealth-watch', TOKEN) });
  try {
    const page = await browser.newPage();
    // Load a real anti-bot detector page, then probe the live environment.
    await page.goto('https://bot.sannysoft.com/', { waitUntil: 'networkidle2', timeout: NAV_TIMEOUT_MS });
    await new Promise((r) => setTimeout(r, 3_000)); // let sannysoft's own tests settle
    const results = await page.evaluate(stealthProbe);
    const ua = await browser.userAgent().catch(() => null);
    const version = await browser.version().catch(() => '');
    const majorMatch = /\/(\d+)\./.exec(version || '');
    const chromiumMajor = majorMatch ? Number(majorMatch[1]) : null;
    await page.close().catch(() => {});

    const creepTrust = await readCreepTrust(browser);

    const score = computeScore(results);
    const generatedAt = new Date().toISOString();
    const badge = badgeJson(score);
    const report = renderReport({ score, results, creepTrust, ua, chromiumMajor, generatedAt });

    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(join(OUT_DIR, 'badge.json'), JSON.stringify(badge, null, 2) + '\n');
    writeFileSync(join(OUT_DIR, 'STEALTH.md'), report);

    const line = JSON.stringify({
      generatedAt, pct: score.pct, passed: score.passed, total: score.total,
      ratio: score.ratio, creepTrust, chromiumMajor, ua, failing: failingChecks(results),
    });
    writeFileSync(join(OUT_DIR, 'result.json'), line + '\n');
    process.stdout.write(line + '\n');
  } finally {
    // disconnect(), never close(): in shared mode close() would kill the browser.
    try { await browser.disconnect(); } catch { /* gone */ }
  }
}

main().catch((err) => {
  console.error(`stealth-check failed: ${err && err.stack || err}`);
  process.exit(1);
});
