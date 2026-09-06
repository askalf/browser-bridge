/**
 * Calibrate the LLM judge against the labeled corpus (demo/judge-corpus.mjs).
 *
 *   PICKET_JUDGE=dario node demo/calibrate-judge.mjs     # real Claude via your subscription
 *   ANTHROPIC_API_KEY=... node demo/calibrate-judge.mjs  # real Claude via a metered key
 *   node demo/calibrate-judge.mjs                         # heuristic stand-in (NOT a real calibration)
 *
 * Feeds every labeled fragment to the judge backend, then sweeps the `minConfidence`
 * threshold and reports precision / recall / F1 at each — so you can pick the value
 * that best balances catching novel injections vs. over-flagging benign content.
 */
import { buildJudgePrompt, VERDICTS_SCHEMA, heuristicBackend } from '../src/judge.mjs';
import { makeClaudeBackend, makeDarioBackend } from '../src/claude-judge.mjs';
import { CORPUS } from './judge-corpus.mjs';

const CURRENT_DEFAULT = 0.6; // LLMJudge's default minConfidence today
const CHUNK = 12;            // judge sends <= maxNodes per call; mirror that batching

const useDario = process.env.PICKET_JUDGE === 'dario' || !!process.env.DARIO_URL;
const useClaude = !useDario && !!process.env.ANTHROPIC_API_KEY;
const backend = useDario ? makeDarioBackend() : useClaude ? makeClaudeBackend() : heuristicBackend;
const label = useDario ? `dario → Claude subscription (claude-haiku-4-5) @ ${process.env.DARIO_URL || 'http://localhost:3456'}`
  : useClaude ? 'Claude (claude-haiku-4-5)'
  : 'heuristic stand-in — NOT a real calibration; set PICKET_JUDGE=dario or ANTHROPIC_API_KEY';

const candidatesOf = (frags) => frags.map((f) => ({
  id: f.id, source: 'text', tag: '', hidden: !!f.hidden,
  hiddenReasons: f.hidden ? ['display:none'] : [], text: f.text, currentAction: 'allow', rank: 0,
}));
const norm = (id) => String(id).replace(/^#/, '').trim();
const pct = (x) => (x * 100).toFixed(0).padStart(3) + '%';

async function run() {
  console.log(`\nCalibrating judge [${label}]`);
  console.log(`corpus: ${CORPUS.length} fragments — ${CORPUS.filter((c) => c.injection).length} injection, ${CORPUS.filter((c) => !c.injection).length} benign\n`);

  const byId = new Map();
  for (let i = 0; i < CORPUS.length; i += CHUNK) {
    const candidates = candidatesOf(CORPUS.slice(i, i + CHUNK));
    const { system, user } = buildJudgePrompt(candidates, { task: 'Summarize this page for the user.' });
    let verdicts;
    try { verdicts = await backend({ candidates, system, user, schema: VERDICTS_SCHEMA, ctx: {} }); }
    catch (e) { console.error('backend error:', e.message); process.exit(1); }
    for (const v of verdicts) if (v && v.id != null) byId.set(norm(v.id), v);
  }

  const rows = CORPUS.map((f) => {
    const v = byId.get(f.id) || { injection: false, confidence: 0, reason: '(no verdict returned)' };
    return { ...f, pred: !!v.injection, conf: typeof v.confidence === 'number' ? v.confidence : (v.injection ? 1 : 0), reason: v.reason };
  });

  const score = (t) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
      const flag = r.pred && r.conf >= t;
      if (r.injection && flag) tp++; else if (!r.injection && flag) fp++;
      else if (r.injection && !flag) fn++; else tn++;
    }
    const precision = tp + fp ? tp / (tp + fp) : 1;
    const recall = tp + fn ? tp / (tp + fn) : 1;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { t, tp, fp, fn, tn, precision, recall, f1 };
  };
  const thresholds = Array.from({ length: 20 }, (_, i) => Math.round(i * 5) / 100);
  const sweep = thresholds.map(score);
  const maxF1 = Math.max(...sweep.map((s) => s.f1));
  const band = sweep.filter((s) => Math.abs(s.f1 - maxF1) < 1e-9);   // contiguous optimal range
  const lo = band[0].t, hi = band[band.length - 1].t;
  const cur = score(CURRENT_DEFAULT);
  const defaultOptimal = Math.abs(cur.f1 - maxF1) < 1e-9;
  const nonDiscriminating = hi - lo > 0.1;
  // Recommend the max-margin point: keep the default if it's already optimal, else the band midpoint.
  const rec = defaultOptimal ? CURRENT_DEFAULT : Math.round(((lo + hi) / 2) / 0.05) * 0.05;
  const recScore = score(rec);

  console.log('  thr   precision  recall    F1     TP FP FN TN');
  for (const s of sweep) {
    const mark = Math.abs(s.t - CURRENT_DEFAULT) < 1e-9 ? '  · current default'
      : (Math.abs(s.f1 - maxF1) < 1e-9 ? '  · optimal' : '');
    console.log(`  ${s.t.toFixed(2)}   ${pct(s.precision)}      ${pct(s.recall)}   ${s.f1.toFixed(3)}  ${String(s.tp).padStart(2)} ${String(s.fp).padStart(2)} ${String(s.fn).padStart(2)} ${String(s.tn).padStart(2)}${mark}`);
  }

  console.log(`\n  best F1 = ${maxF1.toFixed(3)} across minConfidence ∈ [${lo.toFixed(2)}, ${hi.toFixed(2)}]${nonDiscriminating ? '  — threshold is non-discriminating on this corpus' : ''}`);
  console.log(`  current default minConfidence=${CURRENT_DEFAULT.toFixed(2)}:  P ${pct(cur.precision)}  R ${pct(cur.recall)}  F1 ${cur.f1.toFixed(3)}`);
  if (defaultOptimal && nonDiscriminating)
    console.log(`  recommendation: KEEP minConfidence=${CURRENT_DEFAULT.toFixed(2)} — already optimal, with margin to both the false-positive and missed-injection cliffs.`);
  else
    console.log(`  recommendation: minConfidence=${rec.toFixed(2)} (max-margin point of the optimal band):  P ${pct(recScore.precision)}  R ${pct(recScore.recall)}  F1 ${recScore.f1.toFixed(3)}`);

  const miss = rows.filter((r) => (r.pred && r.conf >= rec) !== r.injection);
  if (miss.length) {
    console.log(`\n  misclassified at minConfidence=${rec.toFixed(2)} (${miss.length}):`);
    for (const r of miss) console.log(`   ${r.injection ? 'MISSED injection' : 'FALSE positive '} [${r.id}] conf ${r.conf} — "${r.text.slice(0, 64)}…"`);
  } else {
    console.log(`\n  clean separation — no misclassifications at the recommended threshold.`);
  }
  if (!useDario && !useClaude) console.log(`\n  ⚠ heuristic backend — run with PICKET_JUDGE=dario for a real calibration.`);
}

run();
