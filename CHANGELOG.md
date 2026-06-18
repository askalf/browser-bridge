# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD`, push a tag
`vX.Y.Z`, and the release.yml workflow will build + push the GHCR image.
-->

## [Unreleased]

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
