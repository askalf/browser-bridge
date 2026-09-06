/**
 * Policy plane. picket computes a local verdict deterministically; warden (the
 * Own Your Stack action firewall) gets the final say. The contract is
 * fail-safe: warden may only ESCALATE the local verdict, never soften it, and
 * any transport error leaves the local verdict standing. So a picket on a box
 * with no warden still enforces; a picket with warden inherits org policy.
 *
 * The wire shape below is the integration seam — adjust `decide()` to warden's
 * real endpoint when wiring for real. Until WARDEN_URL is set, LocalPolicy runs.
 */

import { worstAction } from './detect.mjs';

export class LocalPolicy {
  async decide(detection) {
    return { action: detection.verdict, by: 'local', reason: detection.summary };
  }
}

export class WardenClient {
  constructor({ url = process.env.WARDEN_URL, token = process.env.WARDEN_TOKEN, timeoutMs = 1500 } = {}) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.local = new LocalPolicy();
  }

  get enabled() {
    return !!this.url;
  }

  async decide(detection, context = {}) {
    const localVerdict = detection.verdict;
    if (!this.enabled) return this.local.decide(detection);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.url.replace(/\/$/, '')}/v1/decide`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify({
          source: 'picket',
          surface: 'browser',
          verdict: localVerdict,
          trifecta: detection.trifecta,
          score: detection.totalScore,
          context,
          findings: detection.findings.map((f) => ({
            severity: f.severity, categories: f.categories, sinks: f.sinks, excerpt: f.excerpt,
          })),
        }),
      });
      if (!res.ok) throw new Error(`warden ${res.status}`);
      const body = await res.json();
      // warden speaks GREEN/AMBER/BLACK; map onto our lattice, fail-safe upward.
      const map = { green: 'allow', amber: 'flag', red: 'quarantine', black: 'block' };
      const wardenAction = map[String(body.decision || '').toLowerCase()] || localVerdict;
      const action = worstAction(localVerdict, wardenAction);
      return { action, by: 'warden', reason: body.reason || `warden:${body.decision}`, warden: body };
    } catch (err) {
      // Fail safe: keep the local verdict, surface that warden was unreachable.
      const r = await this.local.decide(detection);
      return { ...r, by: 'local', wardenError: String(err && err.message || err) };
    } finally {
      clearTimeout(t);
    }
  }
}

export function makePolicy(opts = {}) {
  return new WardenClient(opts);
}
