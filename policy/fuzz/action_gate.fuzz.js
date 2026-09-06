// Fuzz target: the action plane — the gate an agent's outbound action must pass.
//
// The other targets cover page -> agent. This is agent -> page, and the agent
// may already be under an injection's influence, so every field here is
// attacker-shaped: the action type, the navigation URL, the selector, the typed
// text. GovernedBrowser.gate is DEFAULT-DENY by design, and that posture is the
// invariant worth fuzzing — a crafted action must never be waved through and
// must never crash the gate (a throw skips the audit entry entirely).
//
// The strict half of the contract, asserted below: an action whose type is not
// in the known set can only ever be denied, and a navigation may only be
// allowed to a host actually on the allowlist.
import { GovernedBrowser } from '../src/govern.mjs';
import { hostOf } from '../src/patterns.mjs';

const ALLOWLIST = ['acme-vendor.example'];
const KNOWN_ACTIONS = new Set(['navigate', 'click', 'type', 'submit']);

const onAllowlist = (host) =>
  !!host && ALLOWLIST.some((d) => host === d || host.endsWith('.' + d));

export function fuzz(data) {
  const s = data.toString('utf8');
  // Slice the bytes into the gate's fields so one input exercises several
  // branches: a real type keyword when the fuzzer finds one, hostile strings
  // everywhere else.
  const [head, ...rest] = s.split('\n');
  const tail = rest.join('\n');
  const types = ['navigate', 'click', 'type', 'submit', head];
  const type = types[data.length % types.length];

  // A fresh browser per iteration keeps the audit log from growing unbounded
  // across a 300s run (state carried between iterations also hides bugs).
  const browser = new GovernedBrowser({ allowlist: ALLOWLIST, task: 'fuzz' });

  // No try/catch: gate() is total by contract — it returns a decision for every
  // input, including garbage. Any throw is the bug.
  const decision = browser.gate({
    type,
    url: tail || head,
    selector: head,
    text: tail,
    intent: tail,
  });

  if (typeof decision.allowed !== 'boolean') {
    throw new Error(`gate returned a non-boolean allowed: ${decision.allowed}`);
  }
  // Default-deny: an unrecognized action type has no path to approval.
  if (!KNOWN_ACTIONS.has(type) && decision.allowed) {
    throw new Error(`gate allowed an unrecognized action type: ${JSON.stringify(type)}`);
  }
  // An allowed navigation must resolve to a host genuinely on the allowlist —
  // a URL the parser reads differently than the gate did is exactly the bug
  // class (parser confusion) that lets an agent be steered off-allowlist.
  if (type === 'navigate' && decision.allowed && !onAllowlist(hostOf(tail || head))) {
    throw new Error(`gate allowed off-allowlist navigation: ${JSON.stringify((tail || head).slice(0, 120))}`);
  }
}
