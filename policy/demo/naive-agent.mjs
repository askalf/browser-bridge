/**
 * The naive agent — how almost every browsing agent reads a page today.
 *
 * It scrapes text and hands it to the model as context. "Text" in practice
 * means textContent / the accessibility tree / OCR / attributes / comments —
 * all of which surface content a human never sees. With no provenance boundary,
 * the model cannot tell the page's hidden instructions from the user's task.
 *
 * We reuse picket's own detector here only to LABEL which of the ingested
 * fragments are attacker payloads — the naive agent itself does no filtering;
 * every fragment, payload or not, reaches its model. That is the whole gap.
 */

import { captureFromHtml, detect } from '../src/index.mjs';

/** What a naive scraper feeds the model: every node's text, provenance erased. */
export function naiveContext(html, url) {
  const obs = captureFromHtml(html, { url });
  return obs.nodes.map((n) => n.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

/** The attacker payloads sitting in that context (labeled for illustration). */
export function ingestedInjections(html, url) {
  const obs = captureFromHtml(html, { url });
  return detect(obs).findings.map((f) => ({
    hidden: f.hidden, source: f.source, text: f.excerpt, sinks: f.sinks, severity: f.severity,
  }));
}

export function runNaive(html, url) {
  const ctx = naiveContext(html, url);
  const injections = ingestedInjections(html, url);
  const hiddenCount = injections.filter((i) => i.hidden).length;
  console.log('🤖  NAIVE AGENT — reads the page, hands all text to the model\n');
  console.log(`    model context: ${ctx.length} chars across ${ctx.split('\n').length} text fragments`);
  console.log(`    no provenance boundary — the model treats all of it as equally authoritative\n`);
  console.log(`    Attacker payloads in that context (${hiddenCount} invisible to any human), all reaching the model:`);
  for (const inj of injections) {
    const sink = inj.sinks[0] ? ` → ${inj.sinks[0]}` : '';
    console.log(`      💥 [${inj.hidden ? 'HIDDEN' : 'visible'}/${inj.source}] "${inj.text.slice(0, 88)}${inj.text.length > 88 ? '…' : ''}"${sink}`);
  }
  console.log(`\n    Result: ${injections.length} attacker directive(s) reached the model, indistinguishable`);
  console.log('    from the task. A compliant model exfiltrates the cookie / keeper secrets / keys. PWNED.\n');
  return { contextChars: ctx.length, injections };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('naive-agent.mjs')) {
  const { readFileSync } = await import('node:fs');
  const html = readFileSync(new URL('./booby-trapped.html', import.meta.url), 'utf8');
  runNaive(html, 'https://acme-vendor.example/portal');
}
