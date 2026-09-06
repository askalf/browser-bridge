/**
 * The injection detector.
 *
 * Pure, synchronous, no I/O: an Observation in, a Detection out. Everything
 * here is deterministic and unit-testable. The mental model is Simon Willison's
 * "lethal trifecta" — an attack needs (1) the agent reachable by untrusted
 * content, (2) access to private data, and (3) a way to exfiltrate it. Page
 * content is untrusted by construction, so we score each node for the other
 * two legs plus the imperative that fuses them, and flag co-location.
 */

import {
  INSTRUCTION_TO_AI, AUTHORITY_SPOOF, TOOL_CALL, EXFIL_VERB, SENSITIVE,
  SUSPICIOUS_SINKS, SCHEME_SINK_RE, HARD_INSTRUCTION,
  stripInvisible, foldConfusables, stripSinks, matchAny, matchedLabels,
  extractUrls, extractEmails, hostOf,
} from './patterns.mjs';

/** Verdict / per-node action lattice, strongest last. */
export const ACTIONS = ['allow', 'flag', 'quarantine', 'block'];
export const actionRank = (a) => ACTIONS.indexOf(a);
export const worstAction = (a, b) => (actionRank(a) >= actionRank(b) ? a : b);

const WEIGHTS = {
  instructionToAI: 3,
  authoritySpoof: 3,
  exfilTarget: 3,
  toolCall: 2,
  hidden: 2,
  zeroWidth: 2,
  sensitive: 1,
};

function severityFor(score, trifecta) {
  // block is reserved for the lethal trifecta or an overwhelming pile-up of
  // strong signals; a dangerous-but-non-exfil instruction quarantines instead.
  if (trifecta || score >= 8) return 'critical';
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return 'info';
}

export function severityToAction(sev) {
  switch (sev) {
    case 'critical': return 'block';
    case 'high':
    case 'medium': return 'quarantine';
    case 'low': return 'flag';
    default: return 'allow';
  }
}

/**
 * The exfil leg: an outbound verb in PROSE plus a sink that leaves our origin.
 * A sink is an off-origin URL, any email, a known data-collector host, or a
 * non-http(s) scheme (data:/javascript:/blob:…) that hostOf can't classify.
 * The verb is matched against sink-stripped text so a word inside a hostname or
 * path (e.g. "upload" in upload.wikimedia.org) can't satisfy it on its own.
 *
 * Sinks come from the ORIGINAL text (URL/email hosts must not be mangled by
 * confusable folding); the verb is matched against the FOLDED copy so a
 * homoglyph/fullwidth "ѕend" / "ｓｅｎｄ" still counts as an exfil verb.
 */
function hasExfilLeg(text, folded, ctx) {
  const offOriginUrl = extractUrls(text).some((u) => {
    const h = hostOf(u);
    return h && h !== ctx.originHost;
  });
  const externalSink =
    offOriginUrl ||
    extractEmails(text).length > 0 ||
    SUSPICIOUS_SINKS.some((re) => re.test(text)) ||
    SCHEME_SINK_RE.test(text);
  return externalSink && matchAny(stripSinks(folded), EXFIL_VERB);
}

/**
 * Analyze one node. Returns a Finding, or null when the node is benign.
 * The null path is where false-positive discipline lives: visible marketing
 * text that merely contains a URL or the word "email" must not trip the wire.
 */
export function analyzeNode(node, ctx) {
  const raw = node.text || '';
  const clean = stripInvisible(raw);
  // Smuggling needs something to smuggle. A node whose text is ONLY invisible
  // characters carries no payload a model could act on — that shape is layout
  // and accessibility markup (zero-width break opportunities, bidi marks in a
  // visibility:hidden span), not an attack. Requiring substance keeps this
  // signal consistent with the hidden-with-substance rule below; a zero-width
  // char inserted INTO real text (the actual evasion) still flags, because
  // `clean` is then non-empty.
  const zeroWidth = clean.length !== raw.length && clean.trim().length > 0;
  // Signal matching runs on the confusable-folded copy so homoglyph / fullwidth
  // spellings of an imperative can't slip past the patterns; excerpts, URLs and
  // emails below still derive from `clean` so real hosts stay intact.
  const folded = foldConfusables(raw);

  const signals = {
    hidden: !!node.hidden,
    zeroWidth,
    instructionToAI: matchAny(folded, INSTRUCTION_TO_AI),
    authoritySpoof: matchAny(folded, AUTHORITY_SPOOF),
    toolCall: matchAny(folded, TOOL_CALL),
    sensitive: matchAny(folded, SENSITIVE),
    exfilTarget: false,
  };

  const urls = extractUrls(clean);
  const emails = extractEmails(clean);
  signals.exfilTarget = hasExfilLeg(clean, folded, ctx);

  // A node is only a Finding if it carries a command signal, OR it is hidden
  // with substance, OR it fuses exfil with a reason to care. Pure-hidden
  // boilerplate (sr-only labels, layout comments) — and a hidden node that
  // merely contains a bare URL — are intentionally ignored.
  const commandSignal = signals.instructionToAI || signals.authoritySpoof || signals.toolCall || signals.zeroWidth;
  const hiddenSubstance = signals.hidden && (signals.sensitive || signals.exfilTarget);
  const exfilCombo = signals.exfilTarget && (signals.sensitive || signals.instructionToAI || signals.hidden);
  if (!commandSignal && !hiddenSubstance && !exfilCombo) return null;

  let score = 0;
  for (const k of Object.keys(WEIGHTS)) if (signals[k]) score += WEIGHTS[k];

  // The jackpot: a single node that instructs, names secrets, and exfiltrates.
  const trifecta =
    (signals.instructionToAI || signals.authoritySpoof || signals.toolCall) &&
    signals.sensitive &&
    signals.exfilTarget;

  const severity = severityFor(score, trifecta);

  const categories = [];
  if (signals.instructionToAI) categories.push('instruction-to-ai');
  if (signals.authoritySpoof) categories.push('authority-spoof');
  if (signals.toolCall) categories.push('tool-call');
  if (signals.exfilTarget) categories.push('exfil-lure');
  if (signals.sensitive) categories.push('sensitive-data');
  if (signals.zeroWidth) categories.push('zero-width-smuggling');
  if (signals.hidden) categories.push('hidden-text');

  return {
    nodeId: node.id,
    source: node.source,
    tag: node.tag,
    path: node.path,
    hidden: node.hidden,
    hiddenReasons: node.hiddenReasons || [],
    excerpt: clean.replace(/\s+/g, ' ').trim().slice(0, 160),
    categories,
    signals,
    matched: {
      instructionToAI: matchedLabels(folded, INSTRUCTION_TO_AI),
      authoritySpoof: matchedLabels(folded, AUTHORITY_SPOOF),
      toolCall: matchedLabels(folded, TOOL_CALL),
    },
    sinks: [...new Set([...urls.filter((u) => hostOf(u) && hostOf(u) !== ctx.originHost), ...emails])].slice(0, 5),
    score,
    trifecta,
    severity,
    action: severityToAction(severity),
  };
}

/* Cross-node split detector tunables: how far co-location is allowed to reach. */
const SPLIT_WINDOW_NODES = 5;
const SPLIT_WINDOW_CHARS = 800;

/** An email whose domain is NOT under the page's own registrable domain. */
function hasOffOriginEmail(text, ctx) {
  const emails = extractEmails(text);
  if (emails.length === 0) return false;
  if (!ctx.originHost) return true;
  const root = ctx.originHost.split('.').slice(-2).join('.');
  return emails.some((e) => {
    const dom = (e.split('@')[1] || '').toLowerCase();
    return dom && dom !== root && !dom.endsWith('.' + root);
  });
}

/**
 * A sink that leaves our origin — stricter than the per-node check, which
 * treats ANY email as external. The split window sees more text and so more
 * incidental matches, so a same-origin "email billing@acme.example" contact
 * line must NOT qualify as an exfil destination.
 */
function hasOffOriginSink(text, ctx) {
  const offUrl = extractUrls(text).some((u) => {
    const h = hostOf(u);
    return h && h !== ctx.originHost;
  });
  return offUrl || SUSPICIOUS_SINKS.some((re) => re.test(text)) || SCHEME_SINK_RE.test(text) || hasOffOriginEmail(text, ctx);
}

/** Sink from the ORIGINAL text (hosts unmangled), exfil verb from the FOLDED
 *  copy (homoglyph/fullwidth "ѕend" still counts). */
const hasOffOriginExfilLeg = (text, folded, ctx) =>
  hasOffOriginSink(text, ctx) && matchAny(stripSinks(folded), EXFIL_VERB);

/** Does this node carry a low-FP leg worth redacting as part of a split? Note an
 *  exfil VERB alone does NOT qualify ("email us at…" is benign) — only an
 *  unambiguous instruction, named sensitive data, or an off-origin sink. The
 *  instruction/sensitive legs match on the folded copy; the sink on the original. */
const isSplitContributor = (text, ctx) => {
  const folded = foldConfusables(text);
  return matchAny(folded, HARD_INSTRUCTION) || matchAny(folded, AUTHORITY_SPOOF) ||
    matchAny(folded, SENSITIVE) || hasOffOriginSink(stripInvisible(text), ctx);
};

/**
 * Catch a trifecta SPLIT across adjacent nodes. analyzeNode is per-node, so an
 * attacker can scatter the legs — "ignore previous instructions" in one node,
 * "the session cookie" in the next, the exfil sink in a third — and no single
 * node trips. This slides a small window over consecutive substantive nodes (in
 * DOM order) and re-tests co-location on the concatenation.
 *
 * Precision is the whole concern here; the bar is deliberately high:
 *   - BLOCK: an unambiguous instruction/authority phrase (HARD_INSTRUCTION) +
 *     sensitive data + an OFF-ORIGIN exfil leg, fused within the window.
 *   - QUARANTINE: a HIDDEN span that fuses sensitive data + an off-origin exfil
 *     leg (the hidden "polite" split, which carries no hard imperative).
 * Three guards keep it from firing on benign neighbors of a real injection:
 *   1. windows containing a node that is ALREADY a self-contained block/trifecta
 *      are skipped — that malice is pinned; don't sweep in its neighbors;
 *   2. the exfil leg must be OFF-ORIGIN (same-origin contact info doesn't count);
 *   3. only nodes that themselves carry a leg (isSplitContributor) are redacted.
 * The visible, imperative-free polite split is intentionally left to the LLM
 * judge — catching it deterministically would mean false-positives on ordinary
 * account/help pages.
 */
function detectSplitTrifecta(nodes, ctx, existing) {
  const flagged = new Set(existing.map((f) => f.nodeId));
  const blocked = new Set(existing.filter((f) => f.action === 'block' || f.trifecta).map((f) => f.nodeId));
  const idx = nodes
    .map((n, i) => i)
    .filter((i) => {
      const s = nodes[i].source;
      return (s === 'text' || s === 'comment' || s === 'meta' || s === 'shadow' || s === 'pseudo') && (nodes[i].text || '').trim();
    });
  const out = [];

  for (let a = 0; a < idx.length; a++) {
    const win = [];
    let chars = 0;
    for (let b = a; b < idx.length && win.length < SPLIT_WINDOW_NODES; b++) {
      const node = nodes[idx[b]];
      chars += (node.text || '').length;
      if (win.length && chars > SPLIT_WINDOW_CHARS) break;
      win.push(node);
      if (win.length < 2) continue;
      if (win.some((n) => blocked.has(n.id))) continue; // malice already pinned to one node

      const concat = win.map((n) => n.text || '').join(' • ');
      const text = stripInvisible(concat);       // original — for sinks / hosts
      const folded = foldConfusables(concat);    // canonical — for signal patterns
      const hardInstr = matchAny(folded, HARD_INSTRUCTION) || matchAny(folded, AUTHORITY_SPOOF);
      const sensitive = matchAny(folded, SENSITIVE);
      const exfil = hasOffOriginExfilLeg(text, folded, ctx);
      const hiddenSpan = win.some((n) => n.hidden);

      const isBlock = hardInstr && sensitive && exfil;
      const isQuar = !isBlock && hiddenSpan && sensitive && exfil;
      if (!isBlock && !isQuar) continue;

      // Redact only the leg-bearing nodes the per-node pass let through.
      const fresh = win.filter((n) => !flagged.has(n.id) && isSplitContributor(n.text || '', ctx));
      if (fresh.length === 0) continue;

      const span = win.map((n) => n.id);
      const action = isBlock ? 'block' : 'quarantine';
      for (const n of fresh) {
        flagged.add(n.id);
        const cats = ['split-injection', 'sensitive-data', 'exfil-lure'];
        if (isBlock) cats.push('instruction-to-ai');
        if (n.hidden) cats.push('hidden-text');
        out.push({
          nodeId: n.id, source: n.source, tag: n.tag, path: n.path,
          hidden: !!n.hidden, hiddenReasons: n.hiddenReasons || [],
          excerpt: stripInvisible(n.text || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          categories: cats,
          signals: { split: true, hidden: !!n.hidden, sensitive: true, exfilTarget: true, instructionToAI: isBlock },
          matched: {},
          sinks: [],
          score: isBlock ? 9 : 6,
          trifecta: isBlock,
          severity: isBlock ? 'critical' : 'high',
          action,
          split: {
            span,
            reason: isBlock
              ? 'lethal trifecta split across adjacent nodes'
              : 'hidden span fuses sensitive data with an off-origin exfil sink',
          },
        });
      }
      break; // this start index is accounted for; advance the window origin
    }
  }
  return out;
}

/**
 * Detect over a whole Observation.
 * @param {import('./observation.mjs').Observation} obs
 * @returns {Detection}
 */
export function detect(obs) {
  const ctx = { originHost: hostOf(obs.url) || hostOf(obs.origin) || null };
  const findings = [];
  for (const node of obs.nodes) {
    const f = analyzeNode(node, ctx);
    if (f) findings.push(f);
  }
  for (const f of detectSplitTrifecta(obs.nodes, ctx, findings)) findings.push(f);
  findings.sort((a, b) => actionRank(b.action) - actionRank(a.action) || b.score - a.score);

  const verdict = findings.reduce((acc, f) => worstAction(acc, f.action), 'allow');
  const trifecta = findings.some((f) => f.trifecta);
  const totalScore = findings.reduce((s, f) => s + f.score, 0);

  const counts = findings.reduce((m, f) => ((m[f.severity] = (m[f.severity] || 0) + 1), m), {});
  const summary = findings.length === 0
    ? 'clean — no injection signals'
    : `${findings.length} finding(s): ` +
      ['critical', 'high', 'medium', 'low'].filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ') +
      (trifecta ? ' — LETHAL TRIFECTA present' : '');

  return { verdict, trifecta, totalScore, findings, counts, summary, capturedBy: obs.capturedBy };
}

/**
 * @typedef {Object} Detection
 * @property {('allow'|'flag'|'quarantine'|'block')} verdict
 * @property {boolean} trifecta
 * @property {number}  totalScore
 * @property {Object[]} findings
 * @property {Object}  counts
 * @property {string}  summary
 */
