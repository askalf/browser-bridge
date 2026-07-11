/**
 * Unit tests for stealth-score.mjs's pure scoring/badge/report logic. The live
 * in-browser probe (stealthProbe) is exercised by the stealth-watch workflow;
 * here we pin the deterministic reduction of a results array. Zero-dep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeScore, scoreColor, badgeJson, failingChecks, renderReport, FLOOR,
} from '../stealth-score.mjs';

const mk = (n, pass) => Array.from({ length: n }, (_, i) => ({ name: `c${i}`, pass: i < pass, detail: '' }));

// ── computeScore ────────────────────────────────────────────────────

test('computeScore — counts, ratio, pct', () => {
  assert.deepEqual(computeScore(mk(10, 10)), { passed: 10, total: 10, ratio: 1, pct: 100 });
  assert.deepEqual(computeScore(mk(4, 3)), { passed: 3, total: 4, ratio: 0.75, pct: 75 });
});

test('computeScore — empty/garbage is a zero score, not a throw', () => {
  assert.deepEqual(computeScore([]), { passed: 0, total: 0, ratio: 0, pct: 0 });
  assert.deepEqual(computeScore(undefined), { passed: 0, total: 0, ratio: 0, pct: 0 });
});

// ── scoreColor (thresholds) ─────────────────────────────────────────

test('scoreColor — fixed threshold bands (decoupled from the gate floor)', () => {
  assert.equal(scoreColor(1), 'brightgreen');
  assert.equal(scoreColor(0.95), 'brightgreen');
  assert.equal(scoreColor(0.94), 'green');
  assert.equal(scoreColor(0.85), 'green');
  assert.equal(scoreColor(0.84), 'yellow');
  assert.equal(scoreColor(0.70), 'yellow');
  assert.equal(scoreColor(0.69), 'red');
  assert.equal(scoreColor(0), 'red');
});

test('FLOOR gates only genuinely-broken (red) scores', () => {
  // A couple of env-specific misses (yellow band) must not trip the gate.
  assert.ok(FLOOR < 0.85, 'floor is below the green band');
  assert.ok(scoreColor(FLOOR) === 'yellow' || scoreColor(FLOOR) === 'red');
});

// ── badgeJson (shields endpoint schema) ─────────────────────────────

test('badgeJson — valid shields endpoint shape', () => {
  const b = badgeJson(computeScore(mk(14, 14)));
  assert.equal(b.schemaVersion, 1);
  assert.equal(b.label, 'stealth');
  assert.equal(b.message, '100% · 14/14');
  assert.equal(b.color, 'brightgreen');
});

test('badgeJson — a failing score is red with the fraction shown', () => {
  const b = badgeJson(computeScore(mk(14, 9))); // 64%
  assert.equal(b.message, '64% · 9/14');
  assert.equal(b.color, 'red');
});

test('badgeJson — empty results render as unknown, not a crash', () => {
  const b = badgeJson(computeScore([]));
  assert.equal(b.message, 'unknown');
  assert.equal(b.color, 'lightgrey');
});

// ── failingChecks ───────────────────────────────────────────────────

test('failingChecks — names of only the failing checks', () => {
  const results = [{ name: 'a', pass: true }, { name: 'b', pass: false }, { name: 'c', pass: false }];
  assert.deepEqual(failingChecks(results), ['b', 'c']);
  assert.deepEqual(failingChecks([]), []);
});

// ── renderReport ────────────────────────────────────────────────────

test('renderReport — includes score, failures, table rows, and creep trust', () => {
  const results = [{ name: 'webdriver-hidden', pass: true, detail: 'webdriver=false' }, { name: 'vendor-google', pass: false, detail: 'vendor=x' }];
  const md = renderReport({
    score: computeScore(results), results, creepTrust: '71.5%',
    ua: 'Mozilla/5.0 ...', chromiumMajor: 140, generatedAt: '2026-07-11T00:00:00Z',
  });
  assert.match(md, /Score: 50% \(1\/2\)/);
  assert.match(md, /Failing: vendor-google/);
  assert.match(md, /CreepJS trust score.*71\.5%/);
  assert.match(md, /`webdriver-hidden`/);
  assert.match(md, /Chromium major: 140/);
});
