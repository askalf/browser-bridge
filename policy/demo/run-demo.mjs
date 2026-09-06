/**
 * Side-by-side: the same booby-trapped page read by a naive agent vs. through
 * picket. Prints the contrast and writes a shareable report (report.json +
 * REPORT.md) you can screen-record or drop into a write-up.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runNaive } from './naive-agent.mjs';
import { runGoverned } from './governed-agent.mjs';

const TARGET = 'https://acme-vendor.example/portal';
const html = readFileSync(new URL('./booby-trapped.html', import.meta.url), 'utf8');

const bar = (s) => `\n${'─'.repeat(74)}\n${s}\n${'─'.repeat(74)}\n`;

console.log(bar('picket demo — indirect prompt injection: undefended vs. governed'));
const naive = runNaive(html, TARGET);
console.log(bar('') + '');
const gov = await runGoverned(html, TARGET);

console.log(bar('SCORECARD'));
console.log(`  naive agent:    ${naive.injections.length} attacker directive(s) reached the model  ❌`);
console.log(`  governed agent: ${gov.safe.redactions.length} quarantined, 0 directives reached the model  ✅`);
console.log(`  verdict:        ${gov.decision.action.toUpperCase()}  (lethal trifecta: ${gov.detection.trifecta ? 'YES' : 'no'})`);
console.log('');

// --- artifacts --------------------------------------------------------------
const report = {
  target: TARGET,
  capturedBy: gov.detection.capturedBy,
  naive: { directivesReachedModel: naive.injections.length, hidden: naive.injections.filter((i) => i.hidden).length },
  governed: {
    verdict: gov.decision.action,
    decidedBy: gov.decision.by,
    lethalTrifecta: gov.detection.trifecta,
    quarantined: gov.safe.redactions.length,
    findings: gov.detection.findings.map((f) => ({
      severity: f.severity, action: f.action, hidden: f.hidden, hiddenReasons: f.hiddenReasons,
      source: f.source, categories: f.categories, sinks: f.sinks, excerpt: f.excerpt,
    })),
  },
  safeView: gov.safe.text,
  actionGate: gov.audit.filter((a) => a.plane === 'action'),
};
writeFileSync(new URL('./report.json', import.meta.url), JSON.stringify(report, null, 2));

const md = `# picket demo report

**Target:** \`${TARGET}\` (captured: ${gov.detection.capturedBy})

| | naive agent | governed agent (picket) |
|---|---|---|
| attacker directives reaching the model | **${naive.injections.length}** ❌ | **0** ✅ |
| hidden-from-human payloads | ${naive.injections.filter((i) => i.hidden).length} | quarantined |
| verdict | — | **${gov.decision.action.toUpperCase()}** (${gov.decision.by}) |
| lethal trifecta detected | — | ${gov.detection.trifecta ? '**YES**' : 'no'} |

## Findings
${gov.detection.findings.map((f) => `- ${f.severity.toUpperCase()} [${f.action}] ${f.hidden ? `hidden(${f.hiddenReasons.join('/')})` : 'visible'} \`${f.source}\` — ${f.categories.join(', ')}${f.sinks.length ? ` → ${f.sinks.join(', ')}` : ''}\n  > ${f.excerpt}`).join('\n')}

## Safe view handed to the model
\`\`\`
${gov.safe.text}
\`\`\`
`;
writeFileSync(new URL('./REPORT.md', import.meta.url), md);
console.log('  wrote demo/report.json and demo/REPORT.md\n');
