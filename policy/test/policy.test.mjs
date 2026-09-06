/**
 * Policy plane — the warden integration seam. picket computes a local verdict
 * deterministically; warden may only ESCALATE it, never soften, and any
 * transport error must leave the local verdict standing. These pin that
 * contract by stubbing the warden HTTP call (no live warden), since the wired
 * escalation path is the one security guarantee that would otherwise pass CI
 * even if a regression let warden downgrade a block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WardenClient, LocalPolicy, makePolicy } from '../src/policy.mjs';

const detectionOf = (verdict, over = {}) => ({
  verdict, trifecta: verdict === 'block', totalScore: 5, findings: [], counts: {}, summary: verdict, ...over,
});

/** Run `fn` with a stubbed global fetch, always restoring the real one. */
function withFetch(impl, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = saved; });
}
const wardenReply = (decision, { ok = true } = {}) => async () => ({
  ok, status: ok ? 200 : 500, json: async () => ({ decision, reason: `warden:${decision}` }),
});

test('policy: LocalPolicy returns the deterministic verdict verbatim', async () => {
  const r = await new LocalPolicy().decide(detectionOf('quarantine'));
  assert.equal(r.action, 'quarantine');
  assert.equal(r.by, 'local');
});

test('policy: WardenClient is disabled (local-only) without a url', async () => {
  const p = new WardenClient({ url: undefined });
  assert.equal(p.enabled, false);
  const r = await p.decide(detectionOf('flag'));
  assert.equal(r.action, 'flag');
  assert.equal(r.by, 'local');
});

test('policy: warden may only ESCALATE, never soften the local verdict', async () => {
  // local=block, warden says green(allow) → must stay block (the core guarantee)
  await withFetch(wardenReply('green'), async () => {
    const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('block'));
    assert.equal(r.action, 'block');
    assert.equal(r.by, 'warden');
  });
  // local=flag, warden says black → escalates to block
  await withFetch(wardenReply('black'), async () => {
    const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('flag'));
    assert.equal(r.action, 'block');
  });
});

test('policy: GREEN/AMBER/RED/BLACK map onto the action lattice', async () => {
  for (const [decision, mapped] of [['green', 'allow'], ['amber', 'flag'], ['red', 'quarantine'], ['black', 'block']]) {
    await withFetch(wardenReply(decision), async () => {
      // local=allow, so worstAction surfaces warden's mapped verdict as the escalation
      const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('allow'));
      assert.equal(r.action, mapped, `${decision} → ${mapped}`);
    });
  }
});

test('policy: an unknown warden decision falls back to the local verdict', async () => {
  await withFetch(wardenReply('chartreuse'), async () => {
    const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('quarantine'));
    assert.equal(r.action, 'quarantine');
  });
});

test('policy: fail-safe — a warden throw or non-ok response keeps the local verdict', async () => {
  await withFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('block'));
    assert.equal(r.action, 'block');
    assert.equal(r.by, 'local');
    assert.ok(r.wardenError, 'the transport error is surfaced');
  });
  await withFetch(wardenReply('green', { ok: false }), async () => {
    const r = await makePolicy({ url: 'http://warden.test' }).decide(detectionOf('quarantine'));
    assert.equal(r.action, 'quarantine');
    assert.equal(r.by, 'local');
    assert.ok(r.wardenError);
  });
});
