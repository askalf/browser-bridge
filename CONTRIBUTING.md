# Contributing to browser-bridge

Thanks for your interest in improving **browser-bridge** — stealth headless
Chromium in a container that exposes the Chrome DevTools Protocol on port 9222,
so Playwright, Puppeteer, MCP browser tools, or any agent can connect to a
remote browser without bundling one. Part of
[Own Your Stack](https://github.com/askalf).

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — follow
  [SECURITY.md](SECURITY.md) to report it privately.

## Development setup

browser-bridge ships as a Docker image; the Node.js code (`launch.mjs`,
`cdp-proxy.mjs`, `session-broker.mjs`, the MCP server) is the runtime. You need
Node.js **22+** to run the unit tests, and Docker to build and boot the image.

```bash
git clone https://github.com/askalf/browser-bridge.git
cd browser-bridge
npm ci        # install from the frozen lockfile (no browser is downloaded)
npm test      # unit tests: cdp-proxy + session-broker + mcp-server

# Build and boot the actual image:
docker build -t browser-bridge:dev .
docker run -d --name bb --shm-size=512m -p 9222:9222 browser-bridge:dev
curl -sf http://127.0.0.1:9222/json/version   # CDP should answer
```

## Making a change

1. Branch off `master`.
2. Keep the change focused — one concern per PR.
3. Add or update unit tests for behavior changes to the proxy, session broker,
   or MCP server. A module imported by `launch.mjs` but never `COPY`'d into the
   image passes unit tests yet crashes at boot, so the CI boot smoke matters —
   run the image locally after Dockerfile changes.
4. If you touch anything that affects evasion (`launch.mjs`, Chromium/puppeteer
   versions, `stealth-score.mjs`), run the stealth battery — it gates a headline
   claim and must stay at or above the score floor.
5. Open a pull request against `master`.

## What CI requires

Every PR must pass these checks to merge:

- `unit-tests` — the cdp-proxy + session-broker + mcp-server suite
- `docker-build` — builds the image and runs a **boot smoke** (the container
  must actually start and reach "stealth Chromium running")
- `analyze (javascript-typescript)` — **CodeQL** static analysis
- `stealth` — the bot-detection battery, run when you touch the browser/launch
  files; **fails if the stealth score drops below the floor**

OpenSSF Scorecard and actionlint also run on the repo.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or
  updated workflow steps must keep this.
- Commit messages: short imperative subject, with a wrapped body explaining the
  *why* when it isn't obvious.

## Releases

Releases are cut by pushing a `vX.Y.Z` tag: `release.yml` builds the multi-arch
image (linux/amd64 + linux/arm64) and pushes it to GHCR with a Sigstore build
attestation. A normal PR needs no release steps.
