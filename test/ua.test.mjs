/**
 * Unit tests for ua.mjs — the UA pool is derived from the ACTUAL installed
 * Chromium, so these pin the parsing/building/selection logic without a real
 * browser (detection uses an injected exec stub). Run with `node --test test/`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChromeMajor, buildUaPool, detectChromeMajor, pickUa,
  UA_TEMPLATES, FALLBACK_CHROME_MAJOR,
} from '../ua.mjs';

// ── parseChromeMajor ────────────────────────────────────────────────

test('parseChromeMajor — Debian chromium --version line', () => {
  assert.equal(parseChromeMajor('Chromium 140.0.7339.185 built on Debian GNU/Linux'), 140);
});

test('parseChromeMajor — Google Chrome and bare version strings', () => {
  assert.equal(parseChromeMajor('Google Chrome 141.0.7390.54'), 141);
  assert.equal(parseChromeMajor('149.0.0.0'), 149);
});

test('parseChromeMajor — unparseable input returns null', () => {
  assert.equal(parseChromeMajor(''), null);
  assert.equal(parseChromeMajor('not a version'), null);
  assert.equal(parseChromeMajor(undefined), null);
});

// ── buildUaPool ─────────────────────────────────────────────────────

test('buildUaPool — substitutes the major into every template', () => {
  const pool = buildUaPool(140);
  assert.equal(pool.length, UA_TEMPLATES.length);
  for (const ua of pool) {
    assert.ok(!ua.includes('{M}'), 'no unreplaced placeholder');
    assert.ok(/(Chrome|CriOS)\/140\.0\.0\.0/.test(ua), `major present: ${ua}`);
    assert.ok(!/\/132\./.test(ua), 'no stale 132');
  }
  // Covers the desktop + mobile platforms.
  assert.ok(pool.some((u) => u.includes('Windows NT 10.0')));
  assert.ok(pool.some((u) => u.includes('Macintosh')));
  assert.ok(pool.some((u) => u.includes('Linux x86_64')));
  assert.ok(pool.some((u) => u.includes('Android')));
  assert.ok(pool.some((u) => u.includes('iPhone') && u.includes('CriOS')));
});

// ── detectChromeMajor (injected exec) ───────────────────────────────

test('detectChromeMajor — reads the major from `--version` output', () => {
  const exec = (bin, args) => {
    assert.equal(args[0], '--version');
    return 'Chromium 142.0.7444.0 built on Debian';
  };
  assert.equal(detectChromeMajor('/usr/bin/chromium', exec), 142);
});

test('detectChromeMajor — falls back when the binary throws (never fails launch)', () => {
  const exec = () => { throw new Error('ENOENT'); };
  assert.equal(detectChromeMajor('/nope/chromium', exec), FALLBACK_CHROME_MAJOR);
});

test('detectChromeMajor — falls back when output is unparseable', () => {
  const exec = () => 'garbage output';
  assert.equal(detectChromeMajor('/usr/bin/chromium', exec), FALLBACK_CHROME_MAJOR);
});

// ── pickUa ──────────────────────────────────────────────────────────

test('pickUa — deterministic per session id, stable across calls', () => {
  const pool = buildUaPool(140);
  const a = pickUa(pool, 'session-xyz', 'seed');
  const b = pickUa(pool, 'session-xyz', 'seed');
  assert.equal(a, b, 'same session id → same UA');
  assert.ok(pool.includes(a));
});

test('pickUa — different sessions can select different UAs (spread)', () => {
  const pool = buildUaPool(140);
  const picks = new Set();
  for (let i = 0; i < 50; i++) picks.add(pickUa(pool, `session-${i}`, 'seed'));
  assert.ok(picks.size > 1, 'the pool is actually exercised across sessions');
});

test('pickUa — falls back to the seed when no session id', () => {
  const pool = buildUaPool(140);
  const viaEmpty = pickUa(pool, '', 'fixed-seed');
  const viaFixed = pickUa(pool, 'fixed-seed', 'ignored');
  assert.equal(viaEmpty, viaFixed, 'empty session id hashes the fallback seed');
});
