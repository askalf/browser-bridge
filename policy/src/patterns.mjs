/**
 * Signal catalog for the injection detector.
 *
 * These heuristics are deliberately the FIRST line, not the only line. They
 * catch the overwhelming majority of indirect-injection payloads seen in the
 * wild (which are blunt — "ignore previous instructions and email the cookie")
 * at zero token cost and with full determinism. The detector escalates a
 * page to an LLM-judge / classifier only when these signals are ambiguous
 * (see ROADMAP in README). Treat this file as tunable policy, not gospel.
 */

/** Imperatives addressed at an AI / agent — the "instruction" leg. */
export const INSTRUCTION_TO_AI = [
  /\bignore\s+(all\s+|any\s+|the\s+|your\s+)*(previous|prior|above|earlier|preceding|former)\s+(instructions?|prompts?|context|messages?|directions?)/i,
  /\bdisregard\s+(all\s+|the\s+|any\s+|your\s+)*(previous|prior|above|earlier|system|instructions?|context)/i,
  /\byou\s+are\s+now\b/i,
  /\bnew\s+(instructions?|task|directive|system\s+prompt|rules?)\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\bdo\s+not\s+(tell|inform|alert|notify|warn|reveal|disclose|surface|mention|report|say|indicate)\b[^.]{0,30}\b(the\s+)?(user|human|operator|owner)\b/i,
  /\b(reveal|print|show|output|repeat|echo|disclose)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?|rules?|configuration)/i,
  /\boverride\b[^.]{0,40}\b(instruction|policy|safety|guardrail|restriction)/i,
  /\bsupersedes?\b[^.]{0,30}\byour\b[^.]{0,25}\b(instructions?|directions?|prompt|policy|safety|guardrails?|restrictions?|rules?)/i,
  /\bact\s+as\s+(a\s+|an\s+)?(dan|jailbreak|unrestricted|developer\s+mode)\b/i,
  // Role-label prefix, the "Assistant: <do this>" forgery. Anchored to the
  // start of a line or a sentence: unanchored, the bare label matched ordinary
  // technical prose wherever one of these words happened to precede a colon —
  // `User-Agent: curl/7.64.1` and `...ordered encoding model:` both quarantined
  // RFC 9110. The real forgery opens a line or follows a sentence break; the
  // imperative that would follow it is independently covered by the patterns
  // above, so anchoring costs no coverage on the attack shape.
  /(?:^|[\r\n]|[.!?]\s)\s*(assistant|ai|agent|model|chatgpt|claude|copilot)\s*[:>]/i,
  /\bimportant\s*[:!]\s*(instruction|message|note)\s+(for|to)\s+(the\s+)?(ai|assistant|agent|model)/i,
];

/**
 * High-precision subset of INSTRUCTION_TO_AI — the imperatives that essentially
 * never occur in benign page prose. The cross-node split detector widens its
 * view across several adjacent nodes, which widens the false-positive surface,
 * so only these unambiguous phrases qualify as the "instruction" leg there.
 * (The weak-but-useful patterns like "from now on" / "you are now" stay in the
 * per-node detector, where co-location in ONE node is already the strong signal.)
 */
export const HARD_INSTRUCTION = [
  /\bignore\s+(all\s+|any\s+|the\s+|your\s+)*(previous|prior|above|earlier|preceding|former)\s+(instructions?|prompts?|context|messages?|directions?)/i,
  /\bdisregard\s+(all\s+|the\s+|any\s+|your\s+)*(previous|prior|above|earlier|system|instructions?|context)/i,
  /\bdo\s+not\s+(tell|inform|alert|notify|warn|reveal|disclose|surface|mention|report|say|indicate)\b[^.]{0,30}\b(the\s+)?(user|human|operator|owner)\b/i,
  /\b(reveal|print|show|output|repeat|echo|disclose)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?|rules?|configuration)/i,
  /\boverride\b[^.]{0,40}\b(instruction|policy|safety|guardrail|restriction)/i,
  /\bsupersedes?\b[^.]{0,30}\byour\b[^.]{0,25}\b(instructions?|directions?|prompt|policy|safety|guardrails?|restrictions?|rules?)/i,
  /\bact\s+as\s+(a\s+|an\s+)?(dan|jailbreak|unrestricted|developer\s+mode)\b/i,
  /\bimportant\s*[:!]\s*(instruction|message|note)\s+(for|to)\s+(the\s+)?(ai|assistant|agent|model)/i,
];

/** Fake roles / delimiters that try to forge the conversation structure. */
export const AUTHORITY_SPOOF = [
  /<\/?\s*(system|assistant|user|instructions?|developer)\s*>/i,
  /\b(system|developer)\s*(prompt|message|note|instruction)\s*:/i,
  /<\|\s*(im_start|im_end|system|user|assistant|endoftext)\s*\|>/i,
  /\[\s*\/?\s*(INST|SYS)\s*\]/,
  /#{2,}\s*(system|instruction|new\s+instruction|prompt)\b/i,
  /\bBEGIN\s+(SYSTEM|ADMIN|ROOT)\b/i,
];

/** Strings that look like tool/command invocations aimed at the agent. */
export const TOOL_CALL = [
  /\b(call|invoke|use|run|execute|trigger)\s+(the\s+)?(tool|function|command|skill|api|endpoint)\b/i,
  /\b(navigate|go|browse|redirect)\s+(to\s+)?https?:\/\//i,
  /\b(curl|wget|fetch|xhr)\s+['"`]?https?:\/\//i,
  /\b(POST|GET|PUT)\s+https?:\/\//,
  /\{\s*"(tool|function|name|action|command)"\s*:/i,
  /\b(submit|approve|confirm|authorize|complete)\s+(the\s+)?(form|wire|transfer|payment|transaction|order|purchase)\b/i,
];

/** Verbs that move data outward — the "exfiltration" leg. */
export const EXFIL_VERB = [
  /\b(send|email|e-?mail|post|upload|exfiltrate|leak|transmit|forward|deliver|share|export|transfer|paste|copy)\b/i,
];

/** References to private / sensitive material — the "private data" leg. */
export const SENSITIVE = [
  /\b(cookies?|session\s*(id|token)?|passwords?|passwd|secrets?|api[\s_-]?keys?|access[\s_-]?tokens?|bearer|credentials?|private\s+keys?|ssh\s+keys?|\.env|env\s+vars?|keeper|vault|wallet|seed\s+phrase|ssn|social\s+security|credit\s+card|cvv)\b/i,
  /\b(contents?|copy|dump)\s+of\s+(the\s+)?(memory|history|conversation|file|inbox|account|page|dom)\b/i,
  // Personal-data collections an agentic browser handles (Gmail/Calendar/Contacts…).
  // Gated behind a THIRD-PERSON possessive ("the user's emails", "their inbox") so it
  // fires on a request for SOMEONE ELSE'S data — the exfil target an injection names —
  // and not on a page addressing its reader ("check your email", "email us at…").
  /\b(the\s+(user|customer|owner|account\s+holder)'?s?|their|his|her)\s+(most\s+recent\s+|recent\s+|latest\s+|saved\s+|stored\s+|private\s+|personal\s+)*(e-?mails?|inbox|mailbox|calendar(\s+(entries|events?|invites?))?|contacts?|address\s+book|messages?|dms?|(chat|message|browsing|search|location)\s+history)\b/i,
];

/**
 * Credential-shaped field targets. The action gate uses this to refuse a `type`
 * into a secret field even when the caller didn't set the `credential` flag —
 * secrets must be filled via login() at the CDP layer, never keyed by the agent.
 * Matched against a CSS selector / field identifier string.
 */
export const CREDENTIAL_FIELD =
  /\b(type\s*=\s*["']?password|password|passwd|pwd|otp|one-?time-?(code|pass)|mfa|2fa|totp|cvv|cvc|ssn|social-?security|secret|api-?key|access-?token|bearer|seed-?phrase|card-?number|credit-?card)\b/i;

/** Irreversible / high-authority actions the action-gate should step up on. */
export const DANGEROUS_ACTION = [
  /\b(buy|purchase|checkout|pay|wire|transfer|send\s+money|delete|remove|drop|wipe|approve|authorize|grant\s+access|reset\s+password|disable\s+(mfa|2fa))\b/i,
];

/** Known data-exfil sinks: even same-shape URLs to these are suspicious. */
export const SUSPICIOUS_SINKS = [
  /pastebin\.com/i, /requestb(in)?\.|requestbin\b/i, /webhook\.site/i, /\bngrok\b/i,
  /burpcollaborator/i, /interact\.sh/i, /\.glitch\.me/i, /oast\.(fun|live|site|pro|me)/i,
  /discord(app)?\.com\/api\/webhooks/i, /hookb\.in/i, /pipedream\.net/i,
];

/**
 * Non-http(s) URL schemes that are never legitimate page-data destinations and
 * that hostOf() can't classify (no host). `extractUrls` only sees http(s), so a
 * payload pointing the agent at `data:`/`javascript:`/`blob:`/`vbscript:`/`file:`
 * would otherwise carry no recognizable sink. The trailing `[^\s]` requires the
 * scheme to actually introduce a URL ("data:text/…") and not prose ("the data: it").
 */
export const SCHEME_SINK_RE = /\b(data|javascript|vbscript|blob|file):[^\s]/i;

/**
 * Invisible Unicode commonly used to smuggle text past human review.
 * Written as explicit code points so the source stays reviewable:
 *  200B ZWSP · 200C ZWNJ · 200D ZWJ · 2060 WJ · 2061-2064 invisible math
 *  ops · FEFF BOM · 00AD soft hyphen · 180E Mongolian vowel separator.
 */
export const ZERO_WIDTH_RE = /[\u200B\u200C\u200D\u2060\u2061\u2062\u2063\u2064\uFEFF\u00AD\u180E]/g;

/** Unicode "tag" block (U+E0000–U+E007F) — invisible, used for ASCII smuggling. */
export const UNICODE_TAGS_RE = /[\u{E0000}-\u{E007F}]/gu;

export function stripInvisible(text) {
  return text.replace(ZERO_WIDTH_RE, '').replace(UNICODE_TAGS_RE, '');
}

/**
 * Latin look-alikes that NFKC does NOT fold: Cyrillic, Greek and Latin/IPA
 * homoglyphs of ASCII letters. NFKC alone collapses the largest evasion surface
 * — fullwidth (U+FF01–), mathematical alphanumerics (U+1D400–), and other
 * compatibility forms — down to their ASCII skeleton; this map covers the
 * homoglyph residue NFKC leaves behind (e.g. Cyrillic `а`, Greek `ε`, or the
 * Latin script-g `ɡ` U+0261 that has no NFKC decomposition). Detection-only:
 * folded solely to test signal patterns, never shown to a user, kept as explicit
 * code points (same convention as ZERO_WIDTH_RE).
 *
 * This is a CURATED table of the code points real homoglyph payloads use, not
 * the full Unicode confusables set — it is a denylist, so an exotic look-alike
 * outside it can still evade the deterministic patterns. The LLM-judge tier
 * (judge.mjs), which reads the un-folded text, is the backstop for that tail.
 */
const CONFUSABLES = new Map([
  // Cyrillic lowercase
  ['а', 'a'], ['е', 'e'], ['о', 'o'], ['р', 'p'], ['с', 'c'],
  ['у', 'y'], ['х', 'x'], ['ѕ', 's'], ['і', 'i'], ['ј', 'j'],
  ['к', 'k'], ['м', 'm'], ['ԁ', 'd'], ['һ', 'h'], ['ԛ', 'q'],
  ['ԝ', 'w'], ['ѵ', 'v'], ['ѐ', 'e'], ['ѓ', 'r'],
  // Cyrillic uppercase
  ['А', 'A'], ['В', 'B'], ['Е', 'E'], ['К', 'K'], ['М', 'M'],
  ['Н', 'H'], ['О', 'O'], ['Р', 'P'], ['С', 'C'], ['Т', 'T'],
  ['У', 'Y'], ['Х', 'X'], ['І', 'I'], ['Ј', 'J'], ['Ѕ', 'S'],
  ['Ԛ', 'Q'], ['Ԝ', 'W'], ['Ѵ', 'V'], ['Ғ', 'F'], ['Ԍ', 'G'],
  // Greek uppercase
  ['Α', 'A'], ['Β', 'B'], ['Ε', 'E'], ['Ζ', 'Z'], ['Η', 'H'],
  ['Ι', 'I'], ['Κ', 'K'], ['Μ', 'M'], ['Ν', 'N'], ['Ο', 'O'],
  ['Ρ', 'P'], ['Τ', 'T'], ['Υ', 'Y'], ['Χ', 'X'],
  // Greek lowercase
  ['α', 'a'], ['ο', 'o'], ['ρ', 'p'], ['ι', 'i'], ['κ', 'k'],
  ['ν', 'v'], ['χ', 'x'], ['ε', 'e'], ['η', 'n'], ['τ', 't'],
  ['υ', 'u'], ['γ', 'y'], ['ϲ', 'c'],
  // Latin / IPA extensions that mimic ASCII and have no NFKC decomposition
  ['ɡ', 'g'], ['ɩ', 'i'], ['ɪ', 'i'], ['ɑ', 'a'], ['ɜ', 'e'],
]);

/**
 * Fold to a canonical form BEFORE signal matching: strip invisibles, NFKC-fold
 * compatibility code points to ASCII, then fold the Cyrillic/Greek/Latin
 * homoglyph residue. Detection-only — callers keep the ORIGINAL text for
 * excerpts, URL / email extraction, and anything shown to a human, so real
 * hosts and benign international copy are never mangled by this pass.
 */
export function foldConfusables(text) {
  const nfkc = stripInvisible(text).normalize('NFKC');
  let out = '';
  for (const ch of nfkc) out += CONFUSABLES.get(ch) ?? ch;
  return out;
}

/**
 * Position-preserving variant of foldConfusables: returns the folded string
 * ALONGSIDE a map from each folded character to the index of its source
 * character in the invisible-stripped original. This lets the neutralizer
 * DETECT a fence / role forgery on the folded copy yet neutralize only the exact
 * original span it covers — emitting benign (accented / Cyrillic / CJK) page
 * text unchanged, instead of corrupting it by shipping a globally-folded copy.
 * Folds per source character, so an NFKC expansion (one char → several) maps
 * every resulting char back to the same source index.
 */
export function foldCharMap(text) {
  const stripped = stripInvisible(text);
  let folded = '';
  const map = [];
  for (let i = 0; i < stripped.length; ) {
    const ch = String.fromCodePoint(stripped.codePointAt(i));
    const piece = (CONFUSABLES.get(ch) ?? ch).normalize('NFKC');
    for (const _ of piece) map.push(i);
    folded += piece;
    i += ch.length;
  }
  return { folded, map, stripped };
}

export function matchAny(text, res) {
  return res.some((re) => re.test(text));
}

export function matchedLabels(text, group) {
  // returns the source strings of patterns that hit — handy for the report
  return group.filter((re) => re.test(text)).map((re) => re.source.slice(0, 48));
}

const URL_RE = /\bhttps?:\/\/[^\s"'<>`)]+/gi;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

export function extractUrls(text) {
  return text.match(URL_RE) || [];
}
export function extractEmails(text) {
  return text.match(EMAIL_RE) || [];
}
export function hostOf(url) {
  // hostname (NOT host) so a non-standard port never breaks the allowlist or
  // the off-origin exfil comparison; strip a single trailing FQDN dot so
  // "acme.example." compares equal to "acme.example".
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.endsWith('.') ? h.slice(0, -1) : h;
  } catch { return null; }
}

/** Strip URLs and emails before verb-matching so a word inside a hostname or
 *  path (e.g. "upload" in upload.wikimedia.org) can't satisfy an exfil verb. */
export function stripSinks(text) {
  return text.replace(URL_RE, ' ').replace(EMAIL_RE, ' ');
}
