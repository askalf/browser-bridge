// Fuzz target: the perception plane over raw, untrusted page bytes.
//
// captureFromHtml -> detect is the widest attack surface fieldpass has. The
// HTML it parses is, by construction, written by whoever controls the page —
// an attacker aiming an indirect prompt injection at the agent reading it. A
// detector that can be crashed by a crafted page is a detector that has been
// disabled, and a disabled detector fails OPEN: the raw injection flows on to
// the model. So the contract across this whole pipeline is "no throw at all" —
// capture and detect have no sanctioned failure mode on hostile bytes.
import { detect, ACTIONS } from '../src/detect.mjs';
import { captureFromHtml } from '../src/capture.mjs';

export function fuzz(data) {
  const html = data.toString('utf8');
  // No try/catch: neither captureFromHtml nor detect has a throw contract, so
  // ANY exception here is the bug this target exists to find.
  const obs = captureFromHtml(html, { url: 'https://acme-vendor.example/page' });
  const detection = detect(obs);

  // The verdict drives the policy decision downstream. An out-of-lattice value
  // would be compared by rank against the allowlist and silently read as
  // "allow" — the exact way a crafted page turns a block into a pass.
  if (!ACTIONS.includes(detection.verdict)) {
    throw new Error(`detect returned an off-lattice verdict: ${detection.verdict}`);
  }
  // A NaN score poisons every comparison it touches (NaN >= 8 is false), so a
  // non-finite total would collapse severity scoring to "info" / allow.
  if (!Number.isFinite(detection.totalScore)) {
    throw new Error(`detect returned a non-finite totalScore: ${detection.totalScore}`);
  }
  // Every finding must itself be well-formed: these fields are what the
  // neutralizer keys on to decide what gets withheld from the model.
  for (const f of detection.findings) {
    if (!ACTIONS.includes(f.action)) {
      throw new Error(`finding has an off-lattice action: ${f.action}`);
    }
    if (!Number.isFinite(f.score)) {
      throw new Error(`finding has a non-finite score: ${f.score}`);
    }
  }
}
