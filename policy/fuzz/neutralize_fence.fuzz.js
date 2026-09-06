// Fuzz target: the provenance fence — the last thing standing between hostile
// page text and the agent's model.
//
// buildSafeObservation wraps page text in a BEGIN/END fence and tells the model
// to treat everything inside as DATA. Two ways that guarantee can be broken,
// both fuzzed here:
//   1. FENCE FORGERY — page text that reproduces the fence markers would let an
//      injection "close" the untrusted region early and continue as trusted
//      narration. escapeForData neutralizes those spans, so the rendered view
//      must contain EXACTLY ONE opening and ONE closing marker no matter what
//      bytes the page supplied. More than one is a confusable/normalization
//      escape; fewer means the fence itself was eaten.
//   2. REDACTION LEAK — anything the detector scored as quarantine/block must
//      be replaced by an opaque placeholder, never emitted as text. A miss here
//      delivers a live injection straight to the model.
// The whole path is also a no-throw contract: a crash in the neutralizer takes
// down the fence-builder itself.
import { detect } from '../src/detect.mjs';
import { buildSafeObservation } from '../src/neutralize.mjs';

// Mirrors the constants in src/neutralize.mjs (not exported — kept in sync here
// deliberately, so a silent change to either marker trips this target).
const FENCE_OPEN = '=== BEGIN UNTRUSTED PAGE DATA ===';
const FENCE_CLOSE = '=== END UNTRUSTED PAGE DATA ===';

const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

/** One Observation node carrying the fuzzer's bytes as page text. Building the
 *  node directly (rather than via captureFromHtml) feeds the neutralizer bytes
 *  the HTML parser would otherwise sanitize — the rawer, stricter path. */
const observationOf = (text) => ({
  url: 'https://acme-vendor.example/page',
  origin: 'https://acme-vendor.example',
  title: '',
  nodes: [{
    id: 'n0', text, source: 'text', tag: 'div', path: '>body>div',
    hidden: false, hiddenReasons: [],
  }],
  capturedBy: 'static',
});

export function fuzz(data) {
  const obs = observationOf(data.toString('utf8'));
  const detection = detect(obs);
  const safe = buildSafeObservation(obs, detection, { task: 'summarize this page' });

  // (1) The fence must survive verbatim and exactly once on each side.
  const opens = occurrences(safe.text, FENCE_OPEN);
  const closes = occurrences(safe.text, FENCE_CLOSE);
  if (opens !== 1 || closes !== 1) {
    throw new Error(`fence integrity broken: ${opens} open / ${closes} close marker(s)`);
  }

  // (2) Nothing the detector condemned may appear as readable text: the safe
  // view must carry its placeholder instead.
  for (const finding of detection.findings) {
    if (finding.action !== 'block' && finding.action !== 'quarantine') continue;
    const marker = `[picket:${finding.action.toUpperCase()} #${finding.nodeId}`;
    if (!safe.text.includes(marker)) {
      throw new Error(`node ${finding.nodeId} scored ${finding.action} but was not redacted`);
    }
  }
}
