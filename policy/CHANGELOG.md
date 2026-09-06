# Changelog

All notable changes to `@askalf/fieldpass` are documented here.

## [Unreleased]

### Changed

- **Repository moved into [askalf/browser-bridge](https://github.com/askalf/browser-bridge)
  as `policy/`.** Package name, bins, env vars and MCP tool names unchanged —
  `npm i @askalf/fieldpass` still works; only the source location and the
  publish workflow (`.github/workflows/fieldpass-publish.yml`) moved.

### Security

- **Scorecard alert #26 named three chromadb advisories the ignore file never
  covered.** `examples/crewai-picket/osv-scanner.toml` listed `PYSEC-2026-311`,
  which aliases to CVE-2026-45829 — a *different* chromadb advisory from the
  three OSSF Scorecard actually reports (CVE-2026-45830 / -45833 / -45831,
  GHSA-2wm9-hf6c-p5cr / GHSA-36p7-vc44-83pf / GHSA-xph7-9rjv-w5fr). The existing
  entry does work — 45829 dropped out of Scorecard's list once it landed, which is
  what proves Scorecard honours this file — it simply never named these IDs, so
  the check stayed at "3 existing vulnerabilities detected". Added all three under
  the same reachability analysis and revisit date. No patched chromadb exists
  (OSV `last_affected` 1.5.9; 1.5.9 is the newest release on PyPI), and chromadb
  is not declared here at all — it arrives transitively through `crewai==1.15.7`'s
  `chromadb~=1.1.0`. Examples only; nothing fieldpass ships has a Python
  dependency.

## [0.6.0] — 2026-09-03

### Added

- **`fieldpass scan <url>` works with no browser configured** (#77). Every URL
  used to route through the CDP path, so with no endpoint set puppeteer got an
  undefined `browserURL` and threw a bare assert stack — which meant
  `npx -y @askalf/fieldpass scan https://…` — the zero-install way to point
  fieldpass at a real page — could never work unless a browser was already
  running.
  Scanning a local *file* was fine, which is why it went unnoticed. A URL with
  `--browser` / `PICKET_BROWSER_URL` / `PICKET_CDP` still takes the CDP path
  unchanged; without one the page is fetched and parsed statically, and fetch
  failures exit 65 with a message instead of a stack trace. The static parser
  cannot resolve computed styles, so class-driven white-on-white and offscreen
  hiding read as visible there — inline and structural hiding are still caught.
  The header states which path ran (`captured: static` plus a note pointing at
  `--browser`), and `--json` now carries `capturedBy` so a caller can branch on
  fidelity.
- **Fuzzing of the injection trust boundary** (#64) — ClusterFuzzLite over the
  action gate, capture/detect, and the neutralize fence, running per-PR in CI.
- `glama.json` for the Glama MCP-server listing (#74).

### Fixed

- **Two false-positive classes found scanning real pages** (#78). Both were the
  same mistake — a signal treated as a command without requiring anything to
  command.
  - *Invisible-only nodes.* `zeroWidth` was `clean.length !== raw.length`, fed
    straight to the command signal, bypassing the module's own
    hidden-with-substance rule three lines below. A node holding **only**
    zero-width characters has no payload to smuggle: on
    `wikipedia/Social_engineering_(security)` that was four `visibility:hidden`
    spans of zero-width break opportunities — QUARANTINE, every finding with an
    empty excerpt. Now requires `clean.trim().length > 0`. A zero-width char
    inserted *into* real text, the actual evasion, still flags.
  - *Unanchored role label.* The `(assistant|ai|agent|model|…)\s*[:>]` forgery
    pattern matched those words before a colon anywhere in a line, so
    `User-Agent: curl/7.64.1` and "…ordered encoding model:" quarantined
    RFC 9110. Now anchored to a line start or sentence break, which is where the
    forgery actually appears; the imperative following a real
    `Assistant: <do this>` is independently covered by the other patterns, so
    anchoring costs no coverage on the attack shape.

  Measured over the same 14 real pages: `wikipedia/Social_engineering` and
  `rfc-editor/rfc9110` go QUARANTINE → ALLOW, `wikipedia/Prompt_injection` drops
  to the one finding that is genuinely an injection payload quoted in its prose,
  the five hostile fixtures and nine other real pages are unchanged.

### Changed

- **`node-html-parser` → `^9.0.1`** (#69), a major bump of a runtime dependency.
- Patched transitive dependencies pinned through `overrides`: `fast-uri`
  (#62, #89), `hono` / `@hono/node-server` (#60, #73), `brace-expansion`,
  and `ip-address` in the lockfile (#72). `@anthropic-ai/sdk` (optional) to
  `^0.122.0`, `puppeteer-core` (optional) to `^25.9.0`.
- **`qs` overridden to `^6.16.0`**, closing GHSA-4mjr-xmp4-gh2g (DoS via
  attacker-controlled `isBuffer`) and GHSA-x5fp-wj9c-mxmx (array-limit bypass
  via bracket-key comma parsing). This is a *runtime* path, not a dev one —
  `@modelcontextprotocol/sdk` → `express` → `qs` — so it parses query strings
  in the `fieldpass-mcp --http` transport. Both were open Dependabot alerts
  against 0.5.1.
- Example projects: vulnerable Python demo deps bumped, with the unfixable
  chromadb advisory documented in an `osv-scanner.toml` ignore (#67).

### Docs

- README rewritten to lead with the demo verdict, promote the incidents suite,
  and correct stale counts (#79); badge row and plumbline cross-link (#63).

## [0.5.1] — 2026-07-18

### Fixed

- **`observe({page})` now routes through the live-capture path** (#56). A
  caller-owned page (a `ContextBroker` checkout, an agent's active browser
  session) passed alone used to miss the bridge check and fall through to the
  static parser with no HTML — it now reads the live session via the CDP
  extractor: computed-style hidden detection, shadow-root descent, no
  navigation, lifecycle untouched. This is the seam askalf's fleet
  `browser_use` tool uses to firewall its current page state in place.
- Dropped an unused binding in the phishing-credentials incident fixture (#55).

## [0.5.0] — 2026-07-16

### Added

- **Incidents suite (`incidents/`, `npm run demo:incidents`)** — the headline
  agentic-browser failures of 2025–2026 reproduced as offline fixtures and driven
  through fieldpass, with shareable receipts written to `incidents/INCIDENTS.md`:
  CometJacking-style page-borne exfil, PleaseFix-style authenticated-session
  secret theft, invisible (white-on-white / offscreen) instructions, the
  Scamlexity counterfeit-store checkout, and agent-driven credential phishing.
  Runs static (browserless, CI) or through real Chrome with `PICKET_CDP`. Locked
  in as a regression + false-positive suite (`test/incidents.test.mjs`).

### Changed

- **Detector coverage** — dogfooding the incidents suite surfaced that two marquee
  attacks landed at `quarantine` (payload withheld, attack stopped) rather than the
  stronger `block`, because their instruction / sensitive-data legs weren't matched.
  The "sensitive data" leg now recognizes the personal-data collections an agentic
  browser actually handles — a **third-person** reference to *the user's* emails /
  inbox / calendar / contacts / message-or-browsing history (gated so a page's own
  "check your email" / "email us at…" copy still can't trip it). The "instruction"
  leg now catches "supersede **your** … instructions/safety/policy" and a broader
  set of "do not \<tell/reveal/surface/mention\> … the user" phrasings. Both
  CometJacking and PleaseFix now resolve to a lethal-trifecta **BLOCK**; the full
  false-positive corpus (real Wikipedia + benign look-alikes) stays clean.

## [0.4.1] — 2026-07-11

### Changed

- **README badge row** — the license, dependency, and "why this matters" items
  in the header were plain text trailing the two SVG badges; they're now flat
  shields.io badges matching the `ci` and OpenSSF Scorecard style, so the header
  renders as one consistent badge row on npm and GitHub. The dependency badge
  also corrects the count from "one" to the actual three runtime dependencies
  (`@modelcontextprotocol/sdk`, `node-html-parser`, `zod`), which npm's own
  dependency list would otherwise contradict. Docs only — no code or API
  changes. (#41)

## [0.4.0] — 2026-07-11

### Added

- **Session-recorder / canon-skill plane over MCP** — the last plane reachable
  only as a JS import (`src/skill.mjs`) is now on the MCP server, closing the
  follow-up from the oracle-over-MCP work. `picket_record_start` opens a named
  recording; passing `record: "<name>"` to `picket_observe` / `picket_gate` /
  `picket_login` appends each governed step (secrets redacted, withheld payloads
  never recorded). `picket_skill_emit` serializes it into a canon-pinnable
  manifest with its `skillHash`; `picket_skill_replay` re-runs a recording (or a
  supplied manifest) against the live browser and reports per-step drift and
  `regressedToInjection`. Recordings live on the shared `GovernedBrowser` (persist
  across HTTP sessions, bounded). Because the manifest crosses back to the agent,
  `picket_skill_emit` reduces each observe golden to a fingerprint (no raw page
  text) — an observe step read through the safe view never showed a withheld
  payload, and the manifest can't recover it — while keeping the per-step
  `verdict`, so recorded hostility still shows. The full-text (non-redacted) form
  stays available via the JS `toCanonSkill()` for operator-side canon scanning.
  MCP tool count 6 → 9. (#30)

## [0.3.0] — 2026-07-11

### Added

- **Replay-verification oracle over MCP** — the deterministic anti-fabrication
  gate (`src/oracle.mjs`) is now reachable from any MCP client, not just as a JS
  import: three new tools on `createPicketServer`. `picket_verify` re-captures
  the real page through the governed browser and checks the caller's
  `containsText`/`absentText`/`verdict`/`golden` claims against it with no LLM in
  the path, culling "the page now shows X" confabulations. `picket_snapshot`
  records a named golden fingerprint (hash + verdict + structure — no raw body in
  the reply); `picket_replay` diffs a re-capture against it, with
  `regressedToInjection` flagging a page that was clean and now trips the
  firewall. The golden store lives on the shared `GovernedBrowser` (persists
  across HTTP sessions, same lifetime as the verdict cache and keeper leases) and
  is bounded. None of the new tools ever echo a withheld injection excerpt — a
  regressed payload is filtered out of the replay diff too. The
  session-recorder / canon-skill plane (`src/skill.mjs`) remains a separate MCP
  surface gap, tracked as a follow-up. (#26)

### Security

- **The HTTP transport refuses an unauthenticated non-loopback bind (audit
  follow-up).** `startPicketHttpServer` now throws if asked to bind a
  non-loopback address without a bearer token — that configuration would have
  been an open, unauthenticated governed browser, and the loopback-only
  DNS-rebinding guard doesn't apply off-loopback. Set `PICKET_MCP_TOKEN`
  (recommended), or pass `allowInsecure: true` / `PICKET_MCP_ALLOW_INSECURE=1` to
  override when the endpoint is fronted by other auth. The default loopback bind
  is unaffected.
- **Hardened the Unicode confusable fold (audit follow-up).** Two weaknesses in
  the fold added for the confusables bypass fix: (1) the `CONFUSABLES` map was a
  narrow Cyrillic/Greek set, so a Latin/IPA look-alike with no NFKC
  decomposition — the script-g `ɡ` (U+0261) — still let `iɡnore all previous
  instructions…` through as `allow`; the map now also covers the Latin/IPA
  homoglyphs and more Greek/Cyrillic letters (it stays a curated denylist, with
  the LLM judge as the backstop for the long tail). (2) `escapeForData` emitted a
  globally-folded copy, which Latinized legitimate Cyrillic/Greek and normalized
  CJK page text in the model-facing safe view; it now folds only to *detect* a
  fence/role/token forgery (via the new position-preserving `foldCharMap`) and
  neutralizes the exact original span, emitting all other bytes — benign
  non-Latin copy — verbatim.
- **Replay oracle now sees visible Shadow DOM / pseudo-element content (audit
  follow-up).** #25 taught the capture plane about open shadow roots
  (`source: 'shadow'`) and CSS `::before`/`::after` (`source: 'pseudo'`), but the
  oracle's `visibleLines` still recognized only `text`/`meta`, so verification was
  blind to that content: `picket_verify`'s truthful claim about shadow-rendered
  text failed, `picket_snapshot` saw a shadow-only page as empty, and
  `picket_replay` reported MATCH on a page whose visible shadow content had
  changed. `visibleLines` now treats `shadow`/`pseudo` as visible (hidden ones
  still excluded), so snapshot/verify/diff track exactly what the capture plane
  sees.

- **Unicode confusables / compatibility forms no longer evade the firewall.**
  The detector previously matched its signal patterns against text that had
  only been zero-width-stripped, so a homoglyph (`Іgnore`, Cyrillic I) or
  fullwidth (`ｉｇｎｏｒｅ`) spelling of an imperative sailed through as benign
  data — and a hidden trifecta so disguised downgraded from `block` to
  `quarantine`, losing the `trifecta` flag. Signal matching now runs on a
  canonical, detection-only fold (`foldConfusables` — strip invisibles → NFKC →
  Cyrillic/Greek confusable map) while excerpts, URL/email extraction and the
  human report keep the original text, so real hosts and benign international
  copy (`café`, `Zürich`, CJK, fullwidth prices) are never mangled. The safe
  view's `escapeForData` folds the same way, so a fullwidth fence
  (`＝＝＝ END UNTRUSTED PAGE DATA ＝＝＝`) or homoglyph role tag (`<ѕystem>`) can no
  longer forge a provenance boundary into the model-facing view. (#24)
- **Capture now descends Shadow DOM, declarative templates and pseudo-element
  content.** The live CDP walk previously iterated only `element.childNodes`, so
  an injection planted inside a web component's **open shadow root** was captured
  as zero nodes — `detect()` saw nothing and the agent read the raw payload. The
  in-page extractor now descends open shadow roots (nodes tagged
  `source: 'shadow'`, host visibility inherited so a `display:none` host hides
  its subtree) and reads CSS `::before`/`::after` `content` (`source: 'pseudo'`,
  with the `attr()`/`counter()`/`url()`/gradient noise forms filtered out). The
  static backend upgrades a declarative `<template shadowrootmode>` into the same
  `source: 'shadow'` capture so the offline corpus carries a fixture; the split
  detector now considers `shadow`/`pseudo` nodes too. Closed shadow roots and
  un-upgraded plain `<template>`s remain unreachable by construction — pinned as
  documented residual edges in `test/capture-shadow.test.mjs` and the README. (#25)

## [0.2.1] — 2026-07-11

### Changed

- **Renamed: `@askalf/picket` → `@askalf/fieldpass`** (npm-publishable name; `picket` is squatted unscoped and the registry create-policy blocks colliding scoped names). GitHub repo becomes `askalf/fieldpass` (old URLs redirect). Legacy `picket`/`picket-mcp` bin aliases retained; MCP tool names and `PICKET_*` env vars unchanged.

### Added

- **Streamable HTTP transport for the MCP server** — `picket-mcp --http`
  serves `picket_observe` / `picket_gate` / `picket_login` as a URL-type MCP
  server, so clients that can't spawn a stdio process (the Claude API MCP
  connector, Managed Agents, remote agent runtimes) can attach. Spec session
  management with every session sharing one governed browser (verdict cache
  and keeper leases persist, same as stdio); binds `127.0.0.1` by default with
  DNS-rebinding protection on loopback, optional constant-time bearer auth
  (`PICKET_MCP_TOKEN`), and an unauthenticated `GET /healthz` liveness probe.
  stdio stays the default transport. (#21)
- **Framework example series** — four runnable, offline, no-API-key examples
  of real agent-framework engines browsing behind the firewall via
  `picket-mcp`: LangGraph.js (`StateGraph`), OpenAI Agents SDK (scripted
  offline model through the genuine `Runner`), CrewAI (`Flow`), and Microsoft
  AutoGen (`AssistantAgent` + `McpWorkbench`). Each reads a booby-trapped
  invoice page, proves the injection is withheld while benign content
  survives, has every hijack action refused at the gate, and shows login
  failing closed with no vault — with captured evidence and pinned versions
  from real runs in each example's `evidence/`. (#22)

## [0.2.0] — 2026-07-01

The complete prototype→product roadmap since the initial release: LLM-judge
escalation, an MCP server, a persona context broker, a replay-verification
oracle, canon-pinnable browser skills, and a hardened firewall core.

### Added

- **LLM-judge escalation tier** — a configurable Claude backend reviews only
  the ambiguous residue the deterministic detector can't rule on, with
  confidence calibration and a message-id round-trip fix (#1), plus a
  content-keyed verdict cache (bounded LRU, fail-safe) to cut repeat LLM
  calls (#3). Escalate-only and inert on error.
- **MCP server** — `picket_observe` / `picket_gate` / `picket_login` exposed
  over stdio via the `picket-mcp` entrypoint, so any MCP client gets the
  governed browser (#4). Observe returns verdict and finding categories only —
  withheld excerpts never cross the wire.
- **ContextBroker** — a pool of isolated, keeper-backed persona contexts on one
  shared browser: login-once per persona, LRU eviction, and non-destructive
  teardown (disconnect, never close) (#5).
- **Replay-verification oracle** — a deterministic snapshot / diff /
  claim-verification gate that culls fabricated "the page shows X" claims
  without an LLM, and flags clean-golden → injection regressions (#6).
- **Canon browser skills** — record a governed session and emit it as a
  canon-pinnable, deterministically replayable skill manifest; secrets are
  redacted and the sha256 skill hash matches canon's pin (#7).
- npm publish workflow and `publishConfig.access: public` (#10).

### Fixed

- **Firewall + action-gate hardening** (#2): `observe()` now prefers the live
  CDP bridge over the static parser when both are available; cross-node
  split-trifecta detection catches legs scattered across sibling nodes; the
  gate default-denies unknown action types; credential typing is inferred from
  field shape even without the flag; the nav allowlist matches `hostname`
  (not host:port); and `data:` / `javascript:` / `blob:` URLs count as exfil
  sinks.
- **Live CDP capture parity** (#8): low-contrast hidden text uses the same
  color-distance threshold as the static backend, and `value` attributes are
  scanned — closing two evasions that only affected the live path.
- The oracle reuses the detector's canonical action lattice instead of a local
  copy (#9).

### Docs

- README repositioned: picket is a standalone Own Your Stack tool that
  composes with the warden · canon · keeper trilogy (#11).

## [0.1.0] — 2026-06-19

Initial public release: deterministic lethal-trifecta detector
(capture → detect → policy → safe view), action gate with warden forwarding,
keeper-backed login that keeps secrets out of agent context, static and live
CDP capture backends, `picket scan` CLI, and the naive-vs-governed demos.
