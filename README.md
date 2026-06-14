# browser-bridge

> _browser-bridge — own your browser — stealth headless Chromium, your CDP endpoint. Part of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it by the token._

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
- **CDP origin lock** — `--remote-allow-origins` defaults to loopback origins instead of `*`, closing the DNS-rebinding / cross-origin CDP hijack hole. CDP libraries (Playwright, Puppeteer) send no Origin header and are unaffected; override with `CDP_ALLOWED_ORIGIN` if your client needs one.
- **Idle page reaper** — clients that die without closing their tabs no longer leak them. Idle blank tabs, pages idle past a TTL, and pages beyond a hard count cap get closed; idle is measured from last *navigation*, so an actively reused page is never reaped. All tunable.
- **Health + metrics** — `/healthz` (CDP-connection health with a cached deep page-load check) and `/metrics` (pages open/created/reaped, nav count, uptime) on container-internal `:9224`. The Docker healthcheck hits `/healthz`, so "unhealthy" means the browser is actually gone — not just that a TCP port answers.
- **Heartbeat logs** — one log line per minute with page/nav/reap counts. Pair with restart policy for self-recovery.

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
| `CDP_ALLOWED_ORIGIN` | loopback origins | Comma-separated Origin header values allowed on CDP websocket connections (`--remote-allow-origins`). Most CDP clients send no Origin header and don't need this. |
| `BRIDGE_HEALTH_PORT` | `9224` | Health/metrics port (binds `127.0.0.1` inside the container). |
| `BRIDGE_REAP_INTERVAL_MS` | `30000` | How often the page reaper runs. |
| `BRIDGE_BLANK_TTL_MS` | `120000` | Reap `about:blank` tabs idle this long. |
| `BRIDGE_MAX_IDLE_MS` | `900000` | Reap any page with no navigation for this long (15m). Raise it if your clients hold pages open while working. |
| `BRIDGE_MAX_PAGES` | `25` | Hard page-count cap; the most-idle pages beyond it are reaped. |

Ports:

- **9222** (TCP) — CDP entry point. The image's `EXPOSE` targets this.
- **9224** (TCP, container-internal) — `/healthz` + `/metrics`, bound to `127.0.0.1` inside the container. The Docker `HEALTHCHECK` hits it; it is intentionally not reachable from outside the container.

## Health & metrics

```bash
docker exec <container> curl -s http://127.0.0.1:9224/healthz
# {"ok":true,"connected":true,"pageCheck":"ok","pagesOpen":2}

docker exec <container> curl -s http://127.0.0.1:9224/metrics
# {"uptimeSec":4211,"pagesOpen":2,"pagesCreated":17,"pagesReaped":3,
#  "navCount":42,"healthChecks":280,"lastReapAt":1765500000000,"connected":true}
```

`/healthz` returns `503` only when the CDP connection is gone (restart the container). A wedged-but-connected Chrome shows up as `"pageCheck":"degraded"` — the deep check opens a throwaway context and evaluates `1+1`, refreshed at most once a minute.

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

## Own Your Stack

Part of **[Own Your Stack](https://github.com/askalf)** — open tools for owning your AI infrastructure instead of renting it by the token. One subscription. Your box. Your terms.

- **[dario](https://github.com/askalf/dario)** — own your routing
- **[deepdive](https://github.com/askalf/deepdive)** — own your research
- **[hands](https://github.com/askalf/hands)** — own your computer-use
- **[agent](https://github.com/askalf/agent)** — own your fleet
- **[browser-bridge](https://github.com/askalf/browser-bridge)** — own your browser _(you are here)_

---
Part of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it. Built by Thomas Sprayberry.
