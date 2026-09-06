/**
 * Replay verification oracle — a DETERMINISTIC gate that culls an agent's
 * "I did it / the page now shows X" fabrications about browser work.
 *
 * The philosophy is the same as the code-audit engine: an LLM may DRAFT the
 * claim, but verification is deterministic — no model in this path, because a
 * model asked "did it work?" will confabulate "yes". Here we re-capture the
 * REAL page (any capture backend → an Observation) and compare it, by exact
 * string/structure, against a recorded golden and/or explicit claims. Every
 * verdict carries concrete evidence (the actual text found/absent, the diff).
 *
 * Three pieces:
 *   snapshot(obs)            → a stable, content-derived fingerprint of a page
 *   diffSnapshots(a, b)      → a structured deterministic diff (replay vs golden)
 *   verifyClaims(obs, claims)→ the fabrication gate: assert claims against reality
 * plus a thin ReplayOracle that records goldens and runs the above.
 */

import { detect, actionRank } from './detect.mjs';

/** Sources that carry text a sighted user actually reads. Includes `shadow`
 *  (open shadow-root text) and `pseudo` (CSS ::before/::after content) — the
 *  live backend emits these for real rendered content, so the verification plane
 *  must treat them as visible too, or it goes blind to exactly what the capture
 *  plane now sees (a shadow-only page would look empty / unchanged). */
const VISIBLE_SOURCES = new Set(['text', 'meta', 'shadow', 'pseudo']);

/** Visible, model-facing text lines (what a user/agent actually sees). */
function visibleLines(obs) {
  return (obs.nodes || [])
    .filter((n) => !n.hidden && VISIBLE_SOURCES.has(n.source) && (n.text || '').trim())
    .map((n) => n.text.replace(/\s+/g, ' ').trim());
}

/** Deterministic, dependency-free string hash (djb2) → stable hex. */
export function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * A golden fingerprint of a page state. Pure function of the Observation, so
 * the same page always yields the same snapshot (and hash).
 * @param {import('./observation.mjs').Observation} obs
 * @param {{detection?: object}} [opts]
 */
export function snapshot(obs, opts = {}) {
  const det = opts.detection || detect(obs);
  const lines = visibleLines(obs);
  const visibleText = lines.join('\n');
  const tags = {};
  for (const n of obs.nodes || []) { const t = n.tag || ''; if (t) tags[t] = (tags[t] || 0) + 1; }
  return {
    url: obs.url || '', origin: obs.origin || '', title: obs.title || '',
    verdict: det.verdict, trifecta: !!det.trifecta,
    visibleText, textHash: stableHash(visibleText),
    nodeCount: (obs.nodes || []).length,
    visibleCount: lines.length,
    hiddenCount: (obs.nodes || []).filter((n) => n.hidden).length,
    tags,
    capturedBy: obs.capturedBy || null,
  };
}

/**
 * Deterministic diff of two snapshots. `match` is true only when the dimensions
 * that matter are identical. Flags security-relevant drift explicitly: a page
 * that was clean in the golden and now flags injection (tamper / supply-chain).
 */
export function diffSnapshots(golden, current) {
  if (!golden) throw new Error('diffSnapshots: no golden');
  const changes = [];
  for (const f of ['title', 'verdict', 'trifecta', 'textHash', 'nodeCount', 'visibleCount']) {
    if (golden[f] !== current[f]) changes.push({ field: f, golden: golden[f], current: current[f] });
  }
  const g = new Set((golden.visibleText || '').split('\n'));
  const c = new Set((current.visibleText || '').split('\n'));
  const addedText = [...c].filter((x) => x && !g.has(x));
  const removedText = [...g].filter((x) => x && !c.has(x));
  const verdictChanged = golden.verdict !== current.verdict;
  const trifectaAppeared = !golden.trifecta && current.trifecta;
  // Use the canonical action lattice (actionRank from detect.mjs) instead of a
  // duplicated local array, so this regression check stays in lockstep with the
  // detector if the lattice ever changes.
  const regressedToInjection =
    trifectaAppeared || actionRank(current.verdict) > actionRank(golden.verdict);
  return { match: changes.length === 0, changes, addedText, removedText, verdictChanged, trifectaAppeared, regressedToInjection };
}

/**
 * The fabrication gate. Assert explicit claims about a page against the REAL
 * re-captured Observation. No LLM — exact substring / structural checks, each
 * with evidence. Returns { pass, results[], verdict }.
 *
 * @param {object} obs
 * @param {{containsText?: string[], absentText?: string[], verdict?: string,
 *          maxNodeDelta?: number, golden?: object, detection?: object}} [claims]
 */
export function verifyClaims(obs, claims = {}) {
  const det = claims.detection || detect(obs);
  const allText = (obs.nodes || []).map((n) => n.text || '').join('\n');
  const visible = visibleLines(obs).join('\n');
  const results = [];
  const add = (claim, pass, evidence) => results.push({ claim, pass: !!pass, evidence });

  for (const needle of claims.containsText || []) {
    const ok = visible.includes(needle);
    add(`page shows "${needle}"`, ok, ok ? 'present in visible text' : 'NOT FOUND in the actual page — claim is fabricated');
  }
  for (const needle of claims.absentText || []) {
    const present = allText.includes(needle);
    add(`page free of "${needle}"`, !present, present ? `PRESENT — claim of absence is false` : 'confirmed absent');
  }
  if (claims.verdict) {
    add(`firewall verdict is ${claims.verdict}`, det.verdict === claims.verdict, `actual verdict: ${det.verdict}`);
  }
  if (claims.golden) {
    const d = diffSnapshots(claims.golden, snapshot(obs, { detection: det }));
    add('matches the golden snapshot', d.match,
      d.match ? 'identical to golden' : `${d.changes.length} field change(s); +${d.addedText.length}/-${d.removedText.length} text lines${d.regressedToInjection ? '; ⚠ REGRESSED TO INJECTION' : ''}`);
    if (typeof claims.maxNodeDelta === 'number') {
      const delta = Math.abs(snapshot(obs, { detection: det }).nodeCount - claims.golden.nodeCount);
      add(`node count within ±${claims.maxNodeDelta} of golden`, delta <= claims.maxNodeDelta, `delta: ${delta}`);
    }
  }
  return { pass: results.length > 0 && results.every((r) => r.pass), results, verdict: det.verdict };
}

/** Records goldens by name and runs replay/verify against them. */
export class ReplayOracle {
  /** @param {{maxGoldens?: number}} [opts] bound the store so an untrusted
   *  caller (e.g. an MCP client) can't grow it without limit; oldest evicted. */
  constructor(opts = {}) {
    this.goldens = new Map();
    this.max = opts.maxGoldens ?? 256;
  }
  /** Capture a known-good state as the golden for `name`. */
  record(name, obs) {
    const s = snapshot(obs);
    // Evict the oldest golden when a NEW name would exceed the bound (Map keeps
    // insertion order); re-recording an existing name just overwrites in place.
    if (!this.goldens.has(name) && this.goldens.size >= this.max) {
      this.goldens.delete(this.goldens.keys().next().value);
    }
    this.goldens.set(name, s);
    return s;
  }
  has(name) { return this.goldens.has(name); }
  /** Re-run: diff a fresh observation against the recorded golden. */
  replay(name, obs) {
    const g = this.goldens.get(name);
    if (!g) throw new Error(`ReplayOracle: no golden named "${name}"`);
    return diffSnapshots(g, snapshot(obs));
  }
  /** Verify claims (optionally against a named golden) against reality. */
  verify(obs, claims = {}) {
    const c = { ...claims };
    if (claims.golden && typeof claims.golden === 'string') c.golden = this.goldens.get(claims.golden);
    return verifyClaims(obs, c);
  }
}
