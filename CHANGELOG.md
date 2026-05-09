# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!--
Release convention: land changes under `## [Unreleased]`. At release
time, rename that heading to `## [X.Y.Z] - YYYY-MM-DD`, push a tag
`vX.Y.Z`, and the release.yml workflow will build + push the GHCR image.
-->

## [Unreleased]

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
