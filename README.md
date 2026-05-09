# browser-bridge

> Stealth headless Chromium in a container. Exposes Chrome DevTools Protocol (CDP) on port 9222. Connect from Playwright, Puppeteer, MCP browser tools, or any agent that wants a remote browser without bundling one.

```bash
docker run --rm -p 9222:9222 --shm-size=512m ghcr.io/askalf/browser-bridge:latest
```

```ts
// Then connect from anywhere on the host
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
```

[![Build](https://img.shields.io/github/actions/workflow/status/askalf/browser-bridge/build.yml?style=flat-square&label=build&labelColor=020612)](https://github.com/askalf/browser-bridge/actions)
[![GHCR](https://img.shields.io/badge/ghcr.io-askalf%2Fbrowser--bridge-00ff88?style=flat-square&labelColor=020612)](https://github.com/askalf/browser-bridge/pkgs/container/browser-bridge)
[![License](https://img.shields.io/badge/MIT-00ff88?style=flat-square&label=license&labelColor=020612)](LICENSE)

## Why

Bundling a browser into every agent / scraper / MCP server / test runner is overhead — image size, OS dependencies, font rendering, fingerprint maintenance. browser-bridge centralizes one browser container that any number of clients can share via CDP. Production-grade defaults (full puppeteer-extra stealth evasions, non-root user, healthcheck, optional VPN proxy) so you don't have to assemble them yourself.

## What you get

- **Stealth** — puppeteer-extra with the full evasion set: `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, WebGL vendor, Chrome runtime, iframe quirks, the works. `--enable-automation` is dropped from the default args. Passes the common bot-detection checks.
- **CDP on 0.0.0.0:9222** — Chromium binds to localhost on recent versions; we use socat to expose it on the wildcard so other containers (or your dev machine) can reach it.
- **Realistic browser args** — 1920×1080 viewport, `en-US,en` lang, accelerated 2D canvas, WebGL on, font-render hinting set. Many "headless" containers fail bot checks because they ship without these; we ship with them.
- **Optional VPN proxy** — set `HTTPS_PROXY` or `HTTP_PROXY` to route Chromium's traffic through a VPN sidecar (Gluetun, etc.). Supported out of the box.
- **Non-root** — runs as the `browser` user, not root. CDP escapes don't get privilege.
- **Healthchecked** — Docker-level healthcheck hits `/json/version` every 15s.
- **Heartbeat logs** — one log line per minute confirming the browser is still connected. Pair with restart policy for self-recovery.

## Use it

### Standalone

```bash
docker run --rm -p 9222:9222 --shm-size=512m ghcr.io/askalf/browser-bridge:latest
```

`--shm-size` matters: Chromium's default `/dev/shm` (64MB) is too small for non-trivial pages and you'll see crashes without it.

### docker-compose

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    expose:
      - "9222"
    shm_size: '512m'
    restart: unless-stopped
```

### With a VPN sidecar (Gluetun)

```yaml
services:
  vpn:
    image: qmcgaw/gluetun
    cap_add: [NET_ADMIN]
    environment:
      VPN_SERVICE_PROVIDER: protonvpn
      OPENVPN_USER: ${VPN_USER}
      OPENVPN_PASSWORD: ${VPN_PASS}

  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    network_mode: "service:vpn"
    shm_size: '512m'
    environment:
      HTTPS_PROXY: http://localhost:8888
      HTTP_PROXY: http://localhost:8888
```

### Connect from Playwright

```ts
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://example.com');
console.log(await page.title());
```

### Connect from Puppeteer

```ts
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({
  browserWSEndpoint: 'ws://localhost:9222',
});
```

### Connect from an MCP browser tool

The CDP endpoint `http://localhost:9222/json/version` and `ws://localhost:9222/devtools/...` are standard. Most MCP browser servers accept a `browserURL` config option — point it at this container.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Which Chromium binary to launch (rarely needs overriding). |
| `HTTPS_PROXY` | unset | Outbound proxy passed to Chromium as `--proxy-server`. |
| `HTTP_PROXY` | unset | Same as `HTTPS_PROXY`; either works. |

Ports:

- **9222** (TCP) — CDP entry point. The image's `EXPOSE` and `HEALTHCHECK` both target this.

## Image tags

- `ghcr.io/askalf/browser-bridge:latest` — bleeding edge from `master`.
- `ghcr.io/askalf/browser-bridge:v<X.Y.Z>` — pinned releases.
- `ghcr.io/askalf/browser-bridge:vX.Y` and `ghcr.io/askalf/browser-bridge:vX` — minor/major aliases pointing at the latest matching release.

## Security model

- Runs as non-root (`browser:browser`).
- `--no-sandbox` is set inside the container because Chromium's setuid sandbox doesn't work in unprivileged containers; the broader sandbox is the Linux user namespace the container provides.
- CDP is exposed without authentication — anyone who can reach `:9222` can drive the browser. **Bind to a private network** (docker-compose service network, internal VPN, etc.). Don't expose `:9222` to the public internet.
- Every Chromium command is exposed via CDP. Treat the CDP endpoint with the same care you'd treat raw shell on the container.

## What it isn't

- **Not a queue or scheduler.** It's just one browser. Run multiple containers + a queue (BullMQ, redisflex's InMemoryQueue, whatever) for parallelism.
- **Not session-pinned.** All clients share the same Chromium instance. For session isolation, use Playwright/Puppeteer browser contexts.
- **Not a Chrome extension host.** Headless Chromium doesn't load extensions reliably.

## License

MIT — see [LICENSE](LICENSE).

## Also by askalf

| Project | What it does |
|---------|-------------|
| [arnie](https://github.com/askalf/arnie) | Portable IT troubleshooting companion. Networking, AD, Windows Update, package managers, log triage, hardware checks. |
| [brio](https://github.com/askalf/brio) | Capability layer for AI workloads — semantic cache, cost tiering, policy. Sits in front of any Anthropic-compat endpoint. |
| [claude-bridge](https://github.com/askalf/claude-bridge) | Bridge Claude Code sessions to Discord. |
| [dario](https://github.com/askalf/dario) | Local LLM router. Use your Claude Max/Pro subscription as an API. |
| [deepdive](https://github.com/askalf/deepdive) | Local research agent. Plan → search → fetch → extract → synthesize. Cited answers. |
| [git-providers](https://github.com/askalf/git-providers) | Unified GitHub + GitLab + Bitbucket Cloud REST clients behind one GitProvider interface. Plus a 44-entry api-key-provider taxonomy. |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent. Mouse, keyboard, screen. |
| [install-kit](https://github.com/askalf/install-kit) | curl-pipe-bash template for self-hosted Docker apps. |
| [pgflex](https://github.com/askalf/pgflex) | One Postgres API. Two modes (real PG ↔ PGlite WASM). |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API. Two modes (ioredis ↔ in-process). |
