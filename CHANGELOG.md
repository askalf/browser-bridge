# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD`, push a tag
`vX.Y.Z`, and the release.yml workflow will build + push the GHCR image.
-->

## [Unreleased]

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
- **Unit tests** for the broker (`test/session-broker.test.mjs`, stubbed
  launcher) plus broker-mode cases in `test/cdp-proxy.test.mjs`; the CI
  unit-test job now runs both via `npm test`.

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
