/**
 * Session → signed canon skill — record a governed browsing session once, emit
 * it as a canon-pinnable browser-skill manifest, and replay it deterministically.
 *
 * This wires picket into the canon supply-chain leg. The emitted manifest is a
 * JSON file with a `tools` array, which canon loads as a skill (kind 'mcp'):
 * canon `scan`s every step's description + the whole manifest envelope for
 * poisoning, `pin`s it by content hash, `sign`s it, and `verify`s drift later.
 * Replay is deterministic and uses the oracle (no LLM): each recorded observe
 * is re-captured and diffed against its golden; gates are re-checked.
 *
 * Secrets never enter a recording: a credential `type` is redacted and a login
 * records only the persona + opaque lease id, never the value.
 */

import { createHash } from 'node:crypto';
import { snapshot, diffSnapshots } from './oracle.mjs';

/** Canon-compatible canonical JSON (recursively key-sorted) — so picket's
 *  skillHash equals the content hash canon pins for the same manifest. */
export function canonicalJson(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}

/** The content hash that pins a manifest's identity (matches canon's skillHash). */
export const skillHash = (manifest) => createHash('sha256').update(canonicalJson(manifest)).digest('hex');

function describeStep(s, i) {
  if (s.type === 'observe') return `step ${i + 1}: read ${s.url} — expect verdict ${s.golden.verdict}, ${s.golden.visibleCount} visible node(s)`;
  if (s.type === 'gate') {
    const d = s.decision.allowed ? 'allow' : s.decision.requireApproval ? 'step-up' : 'deny';
    return `step ${i + 1}: action ${s.action.type} ${s.action.url || s.action.selector || ''} → ${d}`;
  }
  if (s.type === 'login') return `step ${i + 1}: login as persona "${s.persona}" (keeper lease, no secret)`;
  return `step ${i + 1}: ${s.type}`;
}

/** Records a governed session: feed it the observations/decisions the agent
 *  already gets from GovernedBrowser. Captures goldens; never captures secrets. */
export class SessionRecorder {
  constructor({ name = 'picket-session', version = '1' } = {}) {
    this.name = name; this.version = version; this.steps = [];
  }
  observe(observation, { label } = {}) {
    this.steps.push({ type: 'observe', label: label || null, url: observation.url, golden: snapshot(observation) });
    return observation;
  }
  gate(action, decision, { label } = {}) {
    const safeAction = { type: action.type, url: action.url, selector: action.selector, intent: action.intent };
    if (action.text != null) safeAction.text = action.credential ? '<redacted>' : action.text; // never record a secret
    this.steps.push({ type: 'gate', label: label || null, action: safeAction,
      decision: { allowed: !!decision.allowed, requireApproval: !!decision.requireApproval, reason: decision.reason } });
    return decision;
  }
  login(persona, lease, { label } = {}) {
    this.steps.push({ type: 'login', label: label || null, persona, lease: (lease && lease.id) || null }); // id only, never the secret
  }
  toSkill() { return toCanonSkill(this); }
}

/** A golden reduced to its safe fingerprint: drops `visibleText` (raw page copy)
 *  while keeping the verdict, textHash and counts. Used when a manifest crosses
 *  an untrusted boundary — an observe step recorded through the SAFE view never
 *  showed the agent a withheld payload, and the emitted manifest must not
 *  recover it. Recorded hostility still shows as `verdict`. */
function redactGolden(g) {
  if (!g || typeof g !== 'object') return g;
  const { visibleText, ...rest } = g;
  return rest;
}

/**
 * Serialize a recorder into a canon-pinnable manifest. canon loads JSON-with-
 * `tools` as a skill and scans each tool description + the manifest envelope
 * (which includes `steps` and their goldens) for poisoning.
 *
 * @param {SessionRecorder} recorder
 * @param {{redactText?: boolean}} [opts] when true, each observe golden is
 *   reduced to its fingerprint (no raw `visibleText`) BEFORE hashing — so the
 *   manifest is safe to hand across an untrusted boundary and its `hash` still
 *   pins exactly the bytes returned. Default false keeps full goldens for
 *   operator-side canon scanning of recorded page content.
 */
export function toCanonSkill(recorder, opts = {}) {
  const steps = opts.redactText
    ? recorder.steps.map((s) => (s.type === 'observe' && s.golden ? { ...s, golden: redactGolden(s.golden) } : s))
    : recorder.steps;
  const tools = steps.map((s, i) => ({ name: `${i + 1}.${s.type}${s.label ? `:${s.label}` : ''}`, description: describeStep(s, i) }));
  const manifest = {
    name: recorder.name,
    version: String(recorder.version),
    kind: 'picket.browser-session',
    generator: 'picket',
    steps,
    tools,
  };
  manifest.hash = skillHash({ ...manifest }); // self-pin; deterministic (no timestamps)
  return manifest;
}

/**
 * Replay a recorded skill deterministically. For each observe step, re-capture
 * via `observe(input)` and diff against the golden (oracle). For each gate step,
 * re-run `gate(action)` and compare the decision. No LLM anywhere.
 *
 * @param {object} skill
 * @param {{observe: (input:object)=>Promise<object>|object, gate?: (action:object)=>object}} backends
 */
export async function replaySkill(skill, { observe, gate } = {}) {
  const report = [];
  for (const s of skill.steps || []) {
    if (s.type === 'observe') {
      if (typeof observe !== 'function') { report.push({ type: 'observe', url: s.url, skipped: 'no observe backend' }); continue; }
      const cur = await observe({ url: s.url });
      const d = diffSnapshots(s.golden, snapshot(cur));
      report.push({ type: 'observe', url: s.url, match: d.match, regressedToInjection: d.regressedToInjection, addedText: d.addedText, removedText: d.removedText, changes: d.changes });
    } else if (s.type === 'gate') {
      if (typeof gate !== 'function') { report.push({ type: 'gate', skipped: 'no gate backend' }); continue; }
      const r = gate(s.action);
      const match = !!r.allowed === s.decision.allowed && !!r.requireApproval === s.decision.requireApproval;
      report.push({ type: 'gate', action: s.action, match, expected: s.decision, got: { allowed: !!r.allowed, requireApproval: !!r.requireApproval } });
    } else {
      report.push({ type: s.type, skipped: 'not replayable' });
    }
  }
  const checked = report.filter((r) => typeof r.match === 'boolean');
  return { pass: checked.length > 0 && checked.every((r) => r.match), report };
}
