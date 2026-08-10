# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD`, push a tag
`vX.Y.Z`, and the release.yml workflow will build + push the GHCR image.
-->

## [0.5.0] - 2026-08-10

### Added — `PROXY_FALLBACK=direct`: an upstream proxy is no longer a hard dependency

- With `PROXY_FALLBACK=direct`, a request the relay cannot get *to* the upstream proxy is retried straight out of the container instead of failing. Off by default, and that default is the interesting part: when a proxy is there for its **exit address**, going direct means the same browser, carrying the same logged-in cookies, suddenly appearing from a different address and a different ASN — the shape of event that trips an account security challenge. For that workload a silent relocation is worse than an outage, so it is the deployment's call, not the image's.
- **Only unreachability fails over — never an answer.** `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `ENETDOWN`, `ETIMEDOUT`, `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `EPIPE`, and a connect timeout. A `407`, a refused `CONNECT`, any status the proxy actually sends is the proxy working and saying no, and is still relayed verbatim; papering over those would convert a wrong password into a silent egress change that nothing would ever report. A test asserts the `407` case specifically.
- **A connect timeout, not just error codes** (`PROXY_CONNECT_TIMEOUT_MS`, default `8000`). This is what actually fires in the likeliest real failure: a tunnel whose far end has gone away swallows packets rather than refusing them, so the socket neither connects nor errors. `net.connect` has no default timeout, so before this the black-hole case would have hung every navigation indefinitely — the failover would never have run in the case it was written for. The timeout is armed only until the TCP connect lands, so it can never truncate a long-lived tunnel.
- On the plain-HTTP path the request body is not piped upstream until the socket actually connects, which is what makes the retry replayable — a half-consumed stream cannot be re-sent. `settled` / `piped` flags keep a late error from double-responding.
- **The breaker trips on the first failure, not the third.** Each retry against a dead upstream costs a stalled page load, so there is no value in re-proving it. It re-probes after 30s (`breakerCooldownMs`) and returns to the upstream as soon as it answers, so a proxy that comes back is used again without a restart. A test asserts the second request through an open breaker completes in <250ms.
- Degradation is **reported, never gated on**: `/healthz` gains `egress` (`upstream` | `direct`) and `degraded`, and still returns `200`; `/metrics` gains `egress` and a `proxyFallbacks` counter. A `503` here would hand a working-but-degraded browser to autoheal and to any deploy that health-gates its rollout, turning a degraded egress into a restart loop and an image rollback — strictly worse than the condition being reported.
- `PROXY_FALLBACK=direct` without credentials in the proxy URL logs that it is being ignored rather than failing quietly: the failover lives in the auth relay, and the relay only runs for a credentialed URL.
- 10 new tests in `test/proxy-auth-relay.test.mjs` — off-by-default 502, `CONNECT` fallback on refusal, fallback on a silent (black-hole) upstream, `407` *not* failed over, breaker skipping a dead upstream, breaker staying shut on a healthy one, the plain-HTTP path, `egressStatus()`, and IPv6-bracket handling in `splitHostPort`.

## [0.4.0] - 2026-08-09

### Added — authenticated upstream proxies (`http://user:pass@host:port`)

- `HTTPS_PROXY` / `HTTP_PROXY` now accept credentials. Previously the URL was passed straight to `--proxy-server`, and **Chromium discards the credentials it finds there** — there is no `--proxy-auth` flag, because the browser expects a human to answer the `407`. Every authenticated proxy was therefore unusable from this image: commercial residential and rotating proxies, and any VPN sidecar with auth switched on. The failure mode gave no clue either, since the flag was accepted and only navigation failed.
- When credentials are present, `proxy-auth-relay.mjs` starts a small HTTP proxy on an ephemeral **loopback** port and Chromium is pointed at that instead. The relay adds `Proxy-Authorization: Basic …` to forwarded requests and to the `CONNECT` it issues upstream. Chromium's network stack is untouched.
- Deliberately **not** `page.authenticate()`, the usual workaround. It enables the CDP `Fetch` domain on each page, and this image exists to be driven by *external* CDP clients — a client calling `setRequestInterception` would then be fighting the bridge for the same domain. Trading away request interception to gain proxy auth is the wrong trade here specifically.
- Bytes that arrive alongside the upstream response head, and the bytes Chromium writes immediately after `CONNECT` (the TLS ClientHello), are both forwarded. Dropping either stalls the handshake with no error to explain it.
- A non-200 from upstream is relayed **verbatim** rather than flattened into a 502, so a wrong password surfaces as the proxy's own `407` and is legible in the browser's error.
- Per-hop headers (RFC 9110 §7.6.1) are stripped in both directions. `transfer-encoding` is the one that bites: Node has already decoded a chunked body by the time the relay sees it, so forwarding the header would announce an encoding the bytes no longer carry.
- The password never reaches stdout: the startup line and every relay log message print `http://user:***@host:port`, asserted by a test. Credentials are percent-decoded, so a password containing `@` or `:` survives.
- Authenticated `https://` proxy URLs (TLS to the proxy itself) are rejected at startup rather than failing at first navigation — the relay does not implement that hop.
- The relay binds `127.0.0.1` only and authenticates nobody; it is an open proxy scoped to the container, which is the trust boundary in the normal deployment. `test/proxy-auth-relay.test.mjs` covers the wire behaviour against a fake upstream proxy — credential injection on both paths, tunnel payload in both directions, `407` pass-through, unreachable-upstream `502`, loopback bind, and that a client-supplied `Proxy-Authorization` cannot displace the injected one.

## [0.3.5] - 2026-07-26

### Fixed — a profile on a volume wedged the container on every restart

- Chromium guards a profile with `SingletonLock` (a symlink to `<hostname>-<pid>`), `SingletonCookie` and `SingletonSocket`, and only removes them on a clean exit. Containers are killed, not shut down, so with a **persistent** profile those entries survive into the next container — which has a different hostname — and Chromium refuses to start: *"The profile appears to be in use by another Chromium process (34) on another computer (a2a862525639)"*. The bridge reported `failed to launch: … Code: 21` and the container entered a restart loop, because every retry read the same lock.
- This was latent until v0.3.4. While the configured profile path was still being ignored (#56) the live profile was always a fresh `/tmp/puppeteer_dev_profile-*`, so the lock died with the container. Honouring the path is what made a durable profile possible, and a durable profile is what exposed this.
- `clearStaleSingletonLock()` (`profile-lock.mjs`) now removes those three entries immediately before launch. It probes with `lstat`, **not** `existsSync` — `SingletonLock` points at a target that does not resolve, so `existsSync` returns false for the very file that blocks startup. It removes only those three names and never recurses, because the rest of the profile is the user data a volume exists to preserve; and it never throws, so a profile it cannot tidy still gets a launch attempt with Chromium's own error as the diagnostic.
- Pinning the container hostname is **not** a fix — verified on a live box: a lock written by an earlier container still names the old hostname, so the comparison fails regardless of the current one.
- Only the shared path needs this. Isolated mode already mints a fresh `mkdtemp` directory per session, which cannot carry a stale lock.

## [0.3.4] - 2026-07-26

### Security — dropped the `rimraf@3` dependency chain (GHSA-mh99-v99m-4gvg / CVE-2026-14257)

- `puppeteer-extra-plugin-user-data-dir` pinned to `2.3.3` — declared as a **direct dependency** as well as an `overrides` entry, which removes `rimraf@3 → glob@7 → minimatch@3 → brace-expansion@1` (and their transitives) from the production tree entirely. The direct dependency is load-bearing, not redundant: with only the override, `2.3.3` does not satisfy `…-user-preferences`' declared `^2.4.1`, so npm installs it *nested* under `node_modules/puppeteer-extra-plugin-user-preferences/node_modules/`. `puppeteer-extra` resolves plugin dependencies by requiring them from its own directory, walks up to the top-level `node_modules`, finds nothing, and the container dies at launch with `Cannot find module 'puppeteer-extra-plugin-user-data-dir'`. Declaring it at the root hoists it back to top level and the override then dedupes `…-user-preferences` onto the same copy. `2.3.3` deletes the temporary profile with native `fs.rmSync(..., { recursive, force, maxRetries: 3 })`; `2.4.0` regressed to `rimraf`, and that is the only substantive difference between them — plugin name, requirements, `beforeLaunch`, `onDisconnected` and the delete gating are identical. `puppeteer-extra-plugin-stealth` stays at `2.11.2`, so no evasions are given up.
- The `brace-expansion` override is dropped along with the chain rather than raised: the advisory is only fixed in `brace-expansion@5.0.8`, whose CommonJS build exports `exports.expand` with no default, so forcing it under `minimatch@3` (`var expand = require('brace-expansion'); expand(pattern)`) would throw on every browser teardown — a failure the boot-smoke cannot see. Leaving the override off means any future reintroduction of the package is reported honestly instead of being masked.
- `npm audit --omit=dev` goes from 7 high to 0; closes the Scorecard Vulnerabilities finding.
- Dependabot now ignores `puppeteer-extra-plugin-user-data-dir` `>=2.4.0`. The npm `non-major` group covers minor updates, so without it a routine grouped bump would have restored `2.4.1` — and with it the whole `rimraf` chain — under a PR title that mentions neither. Scoped to `>=2.4.0` so a `2.3.x` patch would still be proposed.

### Fixed — the configured profile directory was silently ignored (#56)

- Both launch paths passed the profile as a `--user-data-dir` entry in `args`. `puppeteer-extra-plugin-user-data-dir` reads puppeteer's `userDataDir` **option**, found nothing, minted its own temp profile, wrote the stealth profile files there, and puppeteer turned that into a *second* `--user-data-dir` flag. **The plugin's directory is the one Chromium used, and the configured one was ignored.** Confirmed in two places: locally on Chromium 150, and on the deployed 0.3.3 container, where `/home/browser/data` was empty while `/tmp/puppeteer_dev_profile-*` held the full profile (`Default/`, `Last Version`, caches). Note that the *ordering* of the two flags differed between those environments — ours came second locally and first in the container — and the plugin's directory won either way, so which one takes effect is not a positional rule worth reasoning from. The fix is to never emit the flag twice.
- In isolated mode the broker's own `mkdtemp` session directory was created and removed for nothing, while the real per-session profile was the plugin's.
- The profile is now passed as the `userDataDir` option through a new pure `buildLaunchOptions()` (`launch-opts.mjs`), used by both the shared and isolated paths. Verified against Chromium 150: one flag, our directory is the reported profile path, it gets its `Default/`, and no stray plugin temp directory is created. Since the plugin adopts a caller-supplied directory as non-temporary, it no longer deletes it on disconnect — in shared mode the container exits with the browser anyway, and in isolated mode the broker's `close()` was already the cleanup owner, so it is now the only one.
- `buildLaunchOptions()` throws if a `--user-data-dir` ever appears in `args`, and `test/launch-opts.test.mjs` asserts there is exactly one profile source. This class of bug was invisible for weeks precisely because nothing asserted it.
- Shared-mode profile location is now overridable with `BRIDGE_USER_DATA_DIR` (default unchanged at `/home/browser/data`), and the resolved path is logged at startup.

## [0.3.3] - 2026-07-24

### Security

- Base Docker image (`node`) digest-bumped to pick up upstream OS/Chromium-dependency patches; dependabot keeps this current going forward. No runtime behavior change.

### Added — continuous fuzzing of the trust boundary (ClusterFuzzLite)

- Two Jazzer.js targets pin the fail-safe contracts where the bridge consumes input it doesn't control. `fuzz/cdp_guards.fuzz.js`: the CDP proxy's pure request guards — the DNS-rebinding Host gate never passes a DNS name, `?token=` never survives into the forwarded path, `Authorization`/`X-Bridge-Token` never leak upstream, and Host is always rewritten to the loopback target. `fuzz/ua.fuzz.js`: `parseChromeMajor` over hostile `--version` output and `pickUa` over client-controlled `?session=` ids (never throws, always in-pool, deterministic per session). The four guard helpers moved from the `createCdpProxy` closure to exported module scope — same bodies, call sites now pass `internalHost` explicitly — so the contracts are testable at all.
- ClusterFuzzLite runs the targets weekly in CI (`cflite.yml`, batch mode); `npm run fuzz` is the fast local repro loop (`FUZZ_SECONDS` overrides the 30s default). Closes the OpenSSF Scorecard Fuzzing check.

### Changed — supply-chain pins + read-only workflow tokens

- `Dockerfile`: base image digest-pinned (dependabot's existing docker ecosystem refreshes it) and `npm install` → `npm ci` so the image builds from the committed lockfile. `actionlint.yml`: the mutable main-branch installer script piped to bash is replaced by a checksum-verified release tarball. Closes the three Scorecard Pinned-Dependencies findings.
- `release.yml`, `stealth.yml`, `codeql.yml`: write scopes (`contents`, `packages`, `security-events`, …) moved from workflow level to the single job that uses them; top level drops to `contents: read`. Same steps, same effective scopes, narrower blast radius. Closes the four Token-Permissions findings.

## [0.3.2] - 2026-07-11

Proves the stealth claim continuously: CI builds the image, drives it through a
bot-detection battery as an ordinary CDP client, and publishes the score as a
badge — failing the build on a regression. Verification only; the runtime image
is unchanged from v0.3.1.

### Added

- **Live stealth-score badge** — a `stealth-score` CI workflow builds the image,
  runs it, and drives it as an ordinary CDP client through a bot-detection
  battery (`stealth-score.mjs` — the vectors sannysoft / CreepJS probe:
  `navigator.webdriver`, plugins/mimeTypes, languages, `window.chrome`, vendor,
  hardwareConcurrency, iframe `contentWindow.chrome`, permissions consistency,
  automation globals, …). The score publishes as a shields.io endpoint badge (on
  the `badges` branch) and the build **fails if it drops below a floor**, so a
  puppeteer-extra or Chromium bump that regresses stealth is caught in public
  rather than shipped silently. Runs on relevant pushes, weekly, and on demand.

## [0.3.1] - 2026-07-11

**v0.3.0's image didn't boot — this republishes a working one.** `session-broker.mjs`
(added in v0.3.0) was never copied into the image, so the container crashed at
startup with a missing-module error; `release.yml` built and pushed it anyway
because CI only ever *built* the image, never ran it. v0.3.1 fixes the `COPY`
and now boots the image in CI so it can't recur — and, while in there, derives
the UA's Chrome major from the real installed Chromium instead of a stale
hardcoded value. Re-pull `:latest`.

### Changed

- **User-agent pool tracks the real Chromium.** The advertised Chrome major is
  now derived at startup from the actual installed browser (`chromium
  --version`) instead of a hardcoded value, so it can never drift from the
  engine that renders the page — a UA-vs-engine mismatch is itself a bot tell,
  and the pool had been pinned to Chrome 132 while the image ships Debian's
  current Chromium. The selection/derivation logic moved to `ua.mjs` and is
  unit-tested; a fallback keeps launch working if detection ever fails.

### Fixed

- **The container now boots after `session isolation` landed (v0.3.0).**
  `launch.mjs` statically imports `session-broker.mjs`, but that module was
  never added to the Dockerfile `COPY`, so the image built cleanly yet crashed
  at startup with a missing-module error (`docker-build` CI only *built* the
  image, never ran it). The `COPY` now globs all runtime modules so a new file
  can't fall out of the image again, and the `build` workflow now **boots** the
  image and waits for the post-launch marker, so a runtime-only break fails CI
  instead of a release.

## [0.3.0] - 2026-07-11

Two ways to get more out of one bridge: **session isolation** (a stealth browser
per connection) and a **built-in MCP endpoint** (drive it from any MCP client
with no puppeteer code). Both are opt-in; the default single-browser behavior is
unchanged.

### Added

- **Session isolation (`BRIDGE_SESSION_MODE=isolated`)** — a session broker
  gives each CDP connection its own stealth Chromium instead of sharing one
  browser. Hard isolation: no client can see or close another client's targets,
  and a client calling `browser.close()` only kills its own session. Stealth is
  preserved — each session launches through the same puppeteer-extra config —
  and the proxy stays a transparent byte-pipe (it routes each connection to its
  session's browser; no CDP frame parsing).
  - `ws://host:9222/?session=<key>` — named session, reused across reconnects,
    reaped after `BRIDGE_SESSION_IDLE_MS` (default 5m) of no connections.
  - `ws://host:9222/` — ephemeral session, disposed when the connection closes.
  - `GET /json/version` mints a session id so a vanilla
    `puppeteer.connect({ browserURL })` / discovery-then-connect client lands on
    a single session.
  - `BRIDGE_MAX_SESSIONS` (default 20) caps concurrent sessions; acquisitions
    past the cap return 503 (a launch-per-connection endpoint is otherwise a
    trivial resource-exhaustion vector).
  - New `/metrics` fields: `mode`, `sessionsActive`, `sessionsReferenced`,
    `sessionsCreatedTotal`, `sessionsRejected`, `maxSessions`.
- **Built-in MCP endpoint (`mcp-server.mjs`)** — drive the bridge from any MCP
  client with no puppeteer/CDP code. It's a thin MCP server that is itself a CDP
  client of the bridge, exposing six tools over Streamable HTTP: `browser_navigate`,
  `browser_screenshot`, `browser_evaluate`, `browser_get_content`,
  `browser_get_console`, `browser_pdf`. Each MCP session opens one bridge
  connection (`?session=mcp-<id>`), so in isolated mode every MCP session gets
  its own stealth browser and in shared mode they share one — stealth, VPN
  routing and reaping are all inherited from the bridge.
  - Run alongside the bridge: `BRIDGE_CDP_URL=http://127.0.0.1:9222 node mcp-server.mjs`;
    point clients at `http://<host>:9225/mcp`.
  - Env: `BRIDGE_MCP_PORT` (9225), `BRIDGE_MCP_PATH` (`/mcp`), `BRIDGE_CDP_URL`
    (`http://127.0.0.1:9222`), and `BRIDGE_TOKEN` (required on MCP requests when
    set, and presented to the bridge).
  - Browser connections are lazy (opened on first tool call), and disposed with
    `disconnect()` — never `close()` — so shared mode is never taken down.
  - Adds `@modelcontextprotocol/sdk` + `zod` as dependencies; the image now
    copies `mcp-server.mjs` and exposes `9225`.
- **Unit tests** — the broker (`test/session-broker.test.mjs`, stubbed launcher)
  plus broker-mode cases in `test/cdp-proxy.test.mjs`, and the MCP tools
  (`test/mcp-server.test.mjs`, a real MCP client over an in-memory transport with
  a fake page — no browser). CI now `npm ci`s before `npm test`.

### Changed

- **Default remains `BRIDGE_SESSION_MODE=shared`** — the single-browser
  behavior is unchanged and isolated mode is strictly opt-in, so existing
  deployments are unaffected until they set the variable.

## [0.2.0] - 2026-07-01

The socat TCP relay that fronted Chromium's loopback-bound CDP on
`0.0.0.0:9222` is replaced by a built-in HTTP-aware proxy
(`cdp-proxy.mjs`). Default behavior is unchanged — same port, same
open access, same pass-through semantics — but the bridge can now do
things a dumb byte-pipe can't.

### Added

- **Token auth (`BRIDGE_TOKEN`)** — when set, every CDP HTTP request and
  WebSocket upgrade must present the token via `Authorization: Bearer`,
  `X-Bridge-Token`, or `?token=` (browserless-style connection string).
  Comparison is timing-safe; the token is stripped before anything is
  forwarded to Chromium. Unset = open, exactly as before.
- **Connect by hostname** — the proxy presents a loopback Host to
  Chromium (whose Host check rejects DNS names) and rewrites
  `webSocketDebuggerUrl` / `devtoolsFrontendUrl` in discovery responses
  back to the host the client used, so
  `connectOverCDP('http://browser:9222')` works with a compose service
  name — no more digging up the container IP. Hostname Hosts are
  accepted when token auth is on (auth defeats DNS rebinding) or with
  explicit `BRIDGE_ALLOW_HOSTNAMES=1`; without either, the bridge keeps
  Chromium's IP/localhost-only posture.
- **Root-path WebSocket resolution** — an upgrade to `/` is resolved to
  the current browser target server-side, so
  `puppeteer.connect({ browserWSEndpoint: 'ws://host:9222/?token=…' })`
  is a one-liner (no `/json/version` discovery round-trip).
- **New metrics** on `/metrics`: `authFailures`, `hostBlocked`,
  `cdpConnectionsTotal`, `cdpConnectionsActive`.
- **Unit tests** (`npm test`, zero-dep `node:test` against a stub CDP
  upstream) + a unit-test job in CI.

### Changed

- socat is no longer installed in the image; the launcher's proxy owns
  `0.0.0.0:9222`. After the WebSocket handshake the proxy is a
  transparent byte-pipe, so there is no per-message overhead on the CDP
  hot path.

## [0.1.0] - 2026-06-11

Upstreams the production hardening this image has been running inside the
askalf platform fleet since 2026-06-10 — the public image and the deployed
bridge are aligned again.

### Added

- **Health + metrics server** on container-internal `127.0.0.1:9224`
  (`BRIDGE_HEALTH_PORT`): `GET /healthz` returns 200 while the CDP
  connection is live (503 otherwise) and carries a cached deep page-load
  check (`pageCheck: ok|degraded`, refreshed at most every 60s);
  `GET /metrics` reports pagesOpen / pagesCreated / pagesReaped /
  navCount / uptime.
- **Idle page reaper** — reclaims tabs leaked by clients that die without
  closing them: idle `about:blank` tabs after `BRIDGE_BLANK_TTL_MS`
  (default 2m), any page with no navigation for `BRIDGE_MAX_IDLE_MS`
  (default 15m), and the most-idle pages beyond the `BRIDGE_MAX_PAGES`
  hard cap (default 25). Idle is measured from last navigation, not
  creation, so actively reused pages are never reaped. Cadence via
  `BRIDGE_REAP_INTERVAL_MS` (default 30s).
- **Page target tracking + navigation logging** — one log line per
  navigation; heartbeat now reports page/nav/reap counts.

### Changed

- **Docker `HEALTHCHECK` now hits `:9224/healthz`** instead of
  `:9222/json/version` — "healthy" now means the launcher's CDP
  connection is actually alive, not just that a TCP port answers.
- `--disable-dev-shm-usage` removed from the Chromium args: run the
  container with `--shm-size=512m` (or compose `shm_size`) as the README
  has always instructed — the flag forced page buffers to slower
  /tmp-on-disk and could fill the writable layer under load.

### Security

- **CDP origin lock** — `--remote-allow-origins` no longer uses `*`; it
  defaults to loopback origins, closing a DNS-rebinding / cross-origin
  CDP hijack vector. CDP libraries (Playwright, Puppeteer, MCP browser
  tools) send no Origin header and are unaffected; browser-based
  DevTools frontends on other origins need `CDP_ALLOWED_ORIGIN`.

## [0.0.1] - 2026-05-09

Initial release. Extracted from a private monorepo where the same image
ran behind a VPN sidecar to do scraping for an autonomous agent fleet.

### Added

- `Dockerfile` — `node:22-slim` base + Debian Chromium + socat + a few
  font packages, ~600 MB image.
- `launch.mjs` — puppeteer-extra with the full stealth evasion set,
  socat fronts CDP from `127.0.0.1:9223` to `0.0.0.0:9222`, optional
  `HTTP[S]_PROXY` for VPN routing, SIGTERM/SIGINT graceful shutdown,
  60s heartbeat log + auto-exit on browser disconnect.
- Realistic-fingerprint Chrome args (1920×1080, en-US, WebGL on,
  accelerated 2D canvas, font-render-hinting). `--enable-automation`
  dropped from the default args (highest-signal bot detector).
- Non-root execution as `browser:browser`.
- Healthcheck on `/json/version`.
- CI build verification on every PR + push.
- Auto-release: tag `vX.Y.Z` triggers a multi-arch GHCR push
  (`ghcr.io/askalf/browser-bridge:<tag>` + `:latest` + `:vX` + `:vX.Y`).
- CodeQL (JavaScript) + actionlint on the YAML.
