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
- **CDP on 0.0.0.0:9222** — Chromium binds to localhost on recent versions; a built-in HTTP-aware proxy fronts it on the wildcard so other containers (or your dev machine) can reach it.
- **Optional token auth** — set `BRIDGE_TOKEN` and every CDP request/WebSocket must present it (`Authorization: Bearer`, `X-Bridge-Token`, or `?token=`). The one thing raw CDP has always been missing. Off by default.
- **Connect by service name** — Chromium rejects DNS names in the Host header, which is why remote-CDP setups usually make you dig up the container IP. The proxy bridges that: `connectOverCDP('http://browser:9222')` works with a compose service name (with token auth on, or via `BRIDGE_ALLOW_HOSTNAMES=1`).
- **Realistic browser args** — 1920×1080 viewport, `en-US,en` lang, accelerated 2D canvas, WebGL on, font-render hinting set. Many "headless" containers fail bot checks because they ship without these; we ship with them.
- **Optional VPN proxy** — set `HTTPS_PROXY` or `HTTP_PROXY` to route Chromium's traffic through a VPN sidecar (Gluetun, etc.). Supported out of the box.
- **Non-root** — runs as the `browser` user, not root. CDP escapes don't get privilege.
- **CDP origin lock** — `--remote-allow-origins` defaults to loopback origins instead of `*`, closing the DNS-rebinding / cross-origin CDP hijack hole. CDP libraries (Playwright, Puppeteer) send no Origin header and are unaffected; override with `CDP_ALLOWED_ORIGIN` if your client needs one.
- **Idle page reaper** — clients that die without closing their tabs no longer leak them. Idle blank tabs, pages idle past a TTL, and pages beyond a hard count cap get closed; idle is measured from last *navigation*, so an actively reused page is never reaped. All tunable.
- **Health + metrics** — `/healthz` (CDP-connection health with a cached deep page-load check) and `/metrics` (pages open/created/reaped, nav count, uptime) on container-internal `:9224`. The Docker healthcheck hits `/healthz`, so "unhealthy" means the browser is actually gone — not just that a TCP port answers.
- **Heartbeat logs** — one log line per minute with page/nav/reap counts. Pair with restart policy for self-recovery.

## Usage

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

### Connect from hands

[hands](https://github.com/askalf/hands) is a computer-use agent that mostly drives the local desktop directly, but its `read_page` tool fetches URLs over plain HTTP. Pointing it at a browser-bridge gives it a real Chromium for the cases where a server bounces non-browser User-Agents or where the page is a JS-heavy SPA:

```ts
// hands/src/tools/read-page.ts — variant using browser-bridge instead of fetch()
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP(
  process.env.BROWSER_BRIDGE_URL ?? 'http://localhost:9222',
);
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  const html = await page.content();
  return { text: cleanHtml(html), meta: { url, finalUrl: page.url(), status: 200 } };
} finally {
  await page.close();
}
```

Set `BROWSER_BRIDGE_URL` in the hands environment to the bridge container's address (e.g. `http://browser-bridge:9222` on a shared docker network).

### Connect from deepdive

[deepdive](https://github.com/askalf/deepdive) is a research agent whose `BrowserSession` (`src/browser.ts`) launches a local Playwright Chromium by default. Swap `chromium.launch()` for `chromium.connectOverCDP()` to share one browser-bridge across many deepdive runs:

```ts
// deepdive/src/browser.ts — BrowserSession.start() using browser-bridge
import { chromium } from 'playwright';

async start(): Promise<void> {
  const bridgeUrl = process.env.BROWSER_BRIDGE_URL;
  if (bridgeUrl) {
    this.browser = await chromium.connectOverCDP(bridgeUrl);
    this.context = this.browser.contexts()[0] ?? await this.browser.newContext({
      userAgent: this.opts.userAgent ?? DEFAULT_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
    });
    return;
  }
  // ...fallback to local chromium.launch() as today
}
```

The browser-bridge container already ships the stealth args deepdive's `STEALTH_ARGS` lists (`--disable-blink-features=AutomationControlled`, the realistic viewport, locale, font-render hinting), so when connected over CDP you can drop deepdive's local args.

### Raw CDP

If you don't want a Playwright/Puppeteer dependency at all, browser-bridge speaks the wire protocol directly. Fetch the WebSocket URL from `/json/version`, open a socket, and send framed JSON-RPC:

```bash
# 1. Discover the WebSocket debugger URL
curl -s http://localhost:9222/json/version | jq -r .webSocketDebuggerUrl
# ws://localhost:9222/devtools/browser/4b3f...
```

```jsonc
// 2. Send a CDP command over that socket — minimal Page.navigate
{ "id": 1, "method": "Page.navigate", "params": { "url": "https://example.com" } }

// Response
{ "id": 1, "result": { "frameId": "ABCD...", "loaderId": "1234..." } }
```

See the [Chrome DevTools Protocol docs](https://chromedevtools.github.io/devtools-protocol/) for the full method surface (`Page.*`, `Network.*`, `Runtime.evaluate`, `DOM.*`, etc.).

### Connect from an MCP browser tool

The CDP endpoint `http://localhost:9222/json/version` and `ws://localhost:9222/devtools/...` are standard. Most MCP browser servers accept a `browserURL` config option — point it at this container.

## Authentication

CDP has no auth story of its own — anyone who can open a socket to `:9222` owns the browser. By default the bridge keeps the classic open behavior (bind it to a private network). Set `BRIDGE_TOKEN` to require a shared secret on every request and WebSocket upgrade instead:

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    expose: ["9222"]
    shm_size: '512m'
    environment:
      BRIDGE_TOKEN: ${BRIDGE_TOKEN}
```

The token can travel three ways — `Authorization: Bearer <token>`, an `X-Bridge-Token` header, or a `?token=` query parameter. Comparison is timing-safe, the token is stripped before anything reaches Chromium, and failures are counted in `/metrics` (`authFailures`).

```ts
// Playwright — ws endpoint with the token in the query string.
// The bridge resolves the root path to the browser target server-side,
// so you don't need the /devtools/browser/<uuid> discovery round-trip.
const browser = await chromium.connectOverCDP('ws://browser:9222/?token=' + process.env.BRIDGE_TOKEN);

// Puppeteer — same one-liner
const browser = await puppeteer.connect({
  browserWSEndpoint: `ws://browser:9222/?token=${process.env.BRIDGE_TOKEN}`,
});
```

```bash
# curl / raw CDP
curl -s "http://localhost:9222/json/version?token=$BRIDGE_TOKEN"
curl -s -H "X-Bridge-Token: $BRIDGE_TOKEN" http://localhost:9222/json/list
```

With a token set you can also connect by DNS/service name (`ws://browser:9222/...` above): Chromium's own Host-header check — which rejects DNS names and doubles as DNS-rebinding protection — is handled by the proxy, and auth covers the rebinding risk. Without a token the bridge keeps Chromium's IP/localhost-only Host behavior; set `BRIDGE_ALLOW_HOSTNAMES=1` if you want service-name connections on an open bridge and accept that trade-off.

## Session isolation

By default the bridge fronts **one** Chromium and every client connects to the same browser: convenient and cheap, but a client that calls `browser.close()` takes the browser down for everyone, and any connection can enumerate or close pages it didn't open. When several independent clients share a bridge, set `BRIDGE_SESSION_MODE=isolated` and each connection gets its **own** stealth Chromium:

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    environment:
      BRIDGE_SESSION_MODE: isolated
      BRIDGE_MAX_SESSIONS: "20"   # concurrent-session cap
    expose: ["9222"]
    shm_size: '512m'
```

- **Hard isolation** — no client sees or closes another's targets; `browser.close()` only kills that client's session.
- **Stealth preserved** — every session launches through the same puppeteer-extra stealth config, so evasions apply exactly as in shared mode.
- **Still a byte-pipe** — the proxy routes each connection to its session's browser; there is no per-message CDP parsing on the hot path.

Choosing a session:

```ts
// Ephemeral — a fresh browser for this connection, disposed on disconnect:
await chromium.connectOverCDP('http://browser:9222');

// Named — reused across reconnects (survives a disconnect until it goes idle),
// for a long-lived logged-in session:
await puppeteer.connect({ browserWSEndpoint: 'ws://browser:9222/?session=my-login' });
```

Named sessions are reaped after `BRIDGE_SESSION_IDLE_MS` (default 5m) with no connections. Acquisitions past `BRIDGE_MAX_SESSIONS` get a `503` — a launch-per-connection endpoint is otherwise an easy resource-exhaustion vector. `isolated` is opt-in; the default stays `shared`.

## MCP endpoint

Ships an optional MCP server (`mcp-server.mjs`) so any MCP client — Claude Code, an agent framework, anything that speaks MCP — can drive the bridge with **no puppeteer or CDP code of its own**. It's a thin MCP server that is itself a CDP client of the bridge, exposing six tools over Streamable HTTP:

| Tool | Does |
|---|---|
| `browser_navigate` | Go to a URL, wait for load, report status + title. |
| `browser_screenshot` | PNG of the viewport (or `fullPage`). |
| `browser_evaluate` | Run a JS expression in the page, return the result. |
| `browser_get_content` | Page as `html` or visible `text`. |
| `browser_get_console` | Console + page-error messages captured this session. |
| `browser_pdf` | Render the page to a PDF resource. |

Run it as a second process alongside the bridge (same image), pointed at the bridge's CDP endpoint:

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    expose: ["9222"]
    shm_size: '512m'
  browser-mcp:
    image: ghcr.io/askalf/browser-bridge:latest
    command: ["node", "/app/mcp-server.mjs"]
    environment:
      BRIDGE_CDP_URL: http://browser:9222
      # BRIDGE_TOKEN: ${BRIDGE_TOKEN}   # required on MCP requests + presented to the bridge
    ports: ["9225:9225"]
```

Then point a client at `http://<host>:9225/mcp`. **Each MCP session opens one bridge connection** (`?session=mcp-<id>`), so with the bridge in isolated session mode every MCP session gets its own stealth browser; in shared mode they share one. The browser is opened lazily on the first tool call and disposed when the MCP session ends. If `BRIDGE_TOKEN` is set it's required on MCP requests (`Authorization: Bearer`, `X-Bridge-Token`, or `?token=`) and presented onward to the bridge.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Which Chromium binary to launch (rarely needs overriding). |
| `HTTPS_PROXY` | unset | Outbound proxy passed to Chromium as `--proxy-server`. |
| `HTTP_PROXY` | unset | Same as `HTTPS_PROXY`; either works. |
| `CDP_ALLOWED_ORIGIN` | loopback origins | Comma-separated Origin header values allowed on CDP websocket connections (`--remote-allow-origins`). Most CDP clients send no Origin header and don't need this. |
| `BRIDGE_TOKEN` | unset | Shared secret required on every CDP request/WebSocket when set (`Authorization: Bearer`, `X-Bridge-Token`, or `?token=`). Unset = open, pre-0.2.0 behavior. |
| `BRIDGE_ALLOW_HOSTNAMES` | unset | Accept DNS-name Host headers (compose service names) *without* a token. Not needed when `BRIDGE_TOKEN` is set. Opt-in because Chromium's Host check doubles as DNS-rebinding protection. |
| `BRIDGE_SESSION_MODE` | `shared` | `shared` = one browser for all clients (default). `isolated` = a browser per connection (see [Session isolation](#session-isolation)). |
| `BRIDGE_MAX_SESSIONS` | `20` | *(isolated)* Concurrent-session cap; acquisitions past it return `503`. |
| `BRIDGE_SESSION_IDLE_MS` | `300000` | *(isolated)* Reap a session this long (5m) after its last connection closes. |
| `BRIDGE_HEALTH_PORT` | `9224` | Health/metrics port (binds `127.0.0.1` inside the container). |
| `BRIDGE_REAP_INTERVAL_MS` | `30000` | How often the page/session reaper runs. |
| `BRIDGE_BLANK_TTL_MS` | `120000` | *(shared)* Reap `about:blank` tabs idle this long. |
| `BRIDGE_MAX_IDLE_MS` | `900000` | *(shared)* Reap any page with no navigation for this long (15m). Raise it if your clients hold pages open while working. |
| `BRIDGE_MAX_PAGES` | `25` | *(shared)* Hard page-count cap; the most-idle pages beyond it are reaped. |
| `BRIDGE_MCP_PORT` | `9225` | *(mcp-server.mjs)* Port the MCP endpoint listens on. |
| `BRIDGE_MCP_PATH` | `/mcp` | *(mcp-server.mjs)* Request path for the MCP endpoint. |
| `BRIDGE_CDP_URL` | `http://127.0.0.1:9222` | *(mcp-server.mjs)* The bridge CDP endpoint the MCP server connects to. |

Ports:

- **9222** (TCP) — CDP entry point. The image's `EXPOSE` targets this.
- **9224** (TCP, container-internal) — `/healthz` + `/metrics`, bound to `127.0.0.1` inside the container. The Docker `HEALTHCHECK` hits it; it is intentionally not reachable from outside the container.
- **9225** (TCP) — the optional [MCP endpoint](#mcp-endpoint), only when you run `mcp-server.mjs`.

## Health & metrics

```bash
docker exec <container> curl -s http://127.0.0.1:9224/healthz
# {"ok":true,"connected":true,"pageCheck":"ok","pagesOpen":2}

docker exec <container> curl -s http://127.0.0.1:9224/metrics
# {"uptimeSec":4211,"pagesOpen":2,"pagesCreated":17,"pagesReaped":3,
#  "navCount":42,"healthChecks":280,"lastReapAt":1765500000000,
#  "authFailures":0,"hostBlocked":0,"cdpConnectionsTotal":5,
#  "cdpConnectionsActive":1,"connected":true}
```

`/healthz` returns `503` only when the CDP connection is gone (restart the container). A wedged-but-connected Chrome shows up as `"pageCheck":"degraded"` — the deep check opens a throwaway context and evaluates `1+1`, refreshed at most once a minute.

## Image tags

- `ghcr.io/askalf/browser-bridge:latest` — bleeding edge from `master`.
- `ghcr.io/askalf/browser-bridge:v<X.Y.Z>` — pinned releases.
- `ghcr.io/askalf/browser-bridge:vX.Y` and `ghcr.io/askalf/browser-bridge:vX` — minor/major aliases pointing at the latest matching release.

## Security model

- Runs as non-root (`browser:browser`).
- `--no-sandbox` is set inside the container because Chromium's setuid sandbox doesn't work in unprivileged containers; the broader sandbox is the Linux user namespace the container provides.
- CDP is unauthenticated **by default** — anyone who can reach `:9222` can drive the browser. **Bind to a private network** (docker-compose service network, internal VPN, etc.), and set `BRIDGE_TOKEN` for defense in depth. Even with a token, don't expose `:9222` to the public internet — CDP was never designed to be an internet-facing protocol.
- Without a token, DNS-name Host headers are refused (Chromium's own anti-DNS-rebinding posture, preserved by the proxy); IP and localhost Hosts work as always.
- Every Chromium command is exposed via CDP. Treat the CDP endpoint with the same care you'd treat raw shell on the container.

## What it isn't

- **Not a queue or scheduler.** It's just one browser. Run multiple containers + a queue (BullMQ or similar) for parallelism.
- **Not session-pinned.** All clients share the same Chromium instance. For session isolation, use Playwright/Puppeteer browser contexts.
- **Not a Chrome extension host.** Headless Chromium doesn't load extensions reliably.

## License

MIT — see [LICENSE](LICENSE).

## Own Your Stack

Part of **[Own Your Stack](https://github.com/askalf)** — open tools for owning your AI infrastructure instead of renting it by the token. One subscription. Your box. Your terms.

- **[dario](https://github.com/askalf/dario)** — own your routing
- **[hybrid](https://github.com/askalf/hybrid)** — own your inference
- **[deepdive](https://github.com/askalf/deepdive)** — own your research
- **[hands](https://github.com/askalf/hands)** — own your computer-use
- **[browser-bridge](https://github.com/askalf/browser-bridge)** — own your browser _(you are here)_
- **[redstamp](https://github.com/askalf/redstamp)** — own your agent security
- **[truecopy](https://github.com/askalf/truecopy)** — own your agent skills
- **[strongroom](https://github.com/askalf/strongroom)** — own your agent secrets
- **[cordon](https://github.com/askalf/cordon)** — own your prompts
- **[fieldpass](https://github.com/askalf/fieldpass)** — own your agent browser
- **[amnesia](https://github.com/askalf/amnesia)** — own your search
- **[askalf](https://askalf.org)** — own your operation: the AI operation that runs Sprayberry Labs

---
Part of **[Own Your Stack](https://github.com/askalf)** — own your AI infrastructure instead of renting it. Built by Thomas Sprayberry.
