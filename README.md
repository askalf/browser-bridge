<div align="center">

# browser-bridge

**Own your browser.**

One stealth headless Chromium in a container, exposing Chrome DevTools Protocol on port 9222 with the two things raw CDP never had: **authentication** and **a trust boundary you can read**. Connect from Playwright, Puppeteer, an MCP client, or any agent that wants a real browser without bundling one.

[![Build](https://img.shields.io/github/actions/workflow/status/askalf/browser-bridge/build.yml?style=for-the-badge&label=build&labelColor=020612)](https://github.com/askalf/browser-bridge/actions/workflows/build.yml)
[![stealth](https://img.shields.io/endpoint?url=https://raw.githubusercontent.com/askalf/browser-bridge/badges/stealth.json&style=for-the-badge&labelColor=020612)](https://github.com/askalf/browser-bridge/actions/workflows/stealth.yml)
[![GHCR](https://img.shields.io/badge/ghcr.io-askalf%2Fbrowser--bridge-00ff88?style=for-the-badge&labelColor=020612)](https://github.com/askalf/browser-bridge/pkgs/container/browser-bridge)
[![License](https://img.shields.io/badge/MIT-00ff88?style=for-the-badge&label=license&labelColor=020612)](LICENSE)

[![CodeQL](https://github.com/askalf/browser-bridge/actions/workflows/codeql.yml/badge.svg)](https://github.com/askalf/browser-bridge/actions/workflows/codeql.yml)
[![ClusterFuzzLite](https://github.com/askalf/browser-bridge/actions/workflows/cflite.yml/badge.svg)](https://github.com/askalf/browser-bridge/actions/workflows/cflite.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/askalf/browser-bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/askalf/browser-bridge)

[What sets it apart](#what-sets-it-apart) · [Who can do what](#who-can-do-what) · [Guarantees](#guarantees-and-how-to-check-them) · [Architecture](#architecture) · [Connect](#connect) · [Proxies](#egress-through-a-proxy) · [Sessions](#session-isolation) · [MCP](#mcp-endpoint) · [Configuration](#configuration) · [Releases](#releases-and-supply-chain)

</div>

---

```bash
docker run --rm -p 127.0.0.1:9222:9222 --shm-size=512m ghcr.io/askalf/browser-bridge:latest
```

```ts
import { chromium } from 'playwright';
const browser = await chromium.connectOverCDP('http://localhost:9222');
```

That is the whole integration. Everything below is about what you are trusting when you do it.

## What sets it apart

Most "headless Chrome in Docker" images are a `Dockerfile` around a browser. browser-bridge is what you get when the CDP port is treated as production infrastructure:

- **The stealth score is measured, not asserted.** On every relevant push and PR, CI builds the image, drives it as an ordinary CDP client, and evaluates the bot-detection vectors that sannysoft and CreepJS probe, in-page, with no network ([`stealth-score.mjs`](stealth-score.mjs)). The badge above is that live number, and the build fails if it drops below the floor. Currently **13/13**.
- **CDP gets an auth story.** Set `BRIDGE_TOKEN` and every request and WebSocket upgrade must present it. The compare is constant-time over a SHA-256 digest, the token is stripped before anything reaches Chromium, and failures are counted in `/metrics`. Off by default, and this README says so in three places rather than hiding it.
- **The trust boundary is fuzzed.** ClusterFuzzLite runs two Jazzer.js targets weekly against the proxy's pure request guards and the user-agent picker ([`fuzz/`](fuzz)): the DNS-rebinding gate never passes a hostname, `?token=` never survives into the forwarded path, auth headers never leak upstream. OpenSSF Scorecard **Fuzzing**, **Pinned-Dependencies**, and **Token-Permissions** all score 10.
- **Authenticated proxies just work.** Chromium discards the `user:pass` in `--proxy-server` and expects a human to answer the `407`. browser-bridge stands up a loopback relay that adds `Proxy-Authorization` on the browser's behalf, without `page.authenticate()`, so your CDP client keeps the `Fetch` domain to itself. The password never reaches the logs.
- **Failover is a deliberate choice, off by default.** `PROXY_FALLBACK=direct` retries an *unreachable* proxy straight out of the container. It never fails over on a `407` or any other answer the proxy sends, because turning a wrong password into a silent change of exit address is worse than an outage.
- **The container has to boot, not just build.** CI runs the image and waits for the post-launch marker. This exists because v0.3.0 shipped an image that built clean and crashed on start; the guard has been there since.
- **The browser's own chatter stays home.** GCM, component update, domain-reliability beacons, and Sync are disabled at launch, so a metered or residential proxy carries only the traffic your client asked for.
- **Ninety-six unit tests, no Docker required.** `npm test` runs the proxy, relay, broker, MCP server, profile lock, and UA suites against fakes and stubs, in seconds.

## Who can do what

A remote browser is a remote shell with a rendering engine. This is who sits on the path and what each party can do, in the default deployment (a private Docker network, no token). "Stores" means retained after the request.

| Party | Can do | Stores |
|---|---|---|
| **Anyone who can reach `:9222`** | Everything CDP allows: navigate anywhere, read every page, run script, read cookies the browser holds, take screenshots. With `BRIDGE_TOKEN` set, nothing without the token (`401`); with a hostname `Host` and no token, nothing (`403`). | Nothing on the bridge. |
| **The CDP proxy** ([`cdp-proxy.mjs`](cdp-proxy.mjs)) | Sees every request and WebSocket frame as bytes. Checks the token, gates the `Host`, rewrites `Host` to loopback, strips the token, and pipes. No per-message CDP parsing on the hot path. | Counters only (`authFailures`, `hostBlocked`, connections). |
| **Chromium** (`browser` user, `--no-sandbox`) | Whatever a page can do inside a Chromium process. Escapes land as the unprivileged `browser` user inside the container; the container is the sandbox. | The profile at `BRIDGE_USER_DATA_DIR` in shared mode (cookies, storage), which persists only if you mount a volume there. Isolated sessions use a fresh directory that is deleted on close. |
| **The auth relay** ([`proxy-auth-relay.mjs`](proxy-auth-relay.mjs), only with a credentialed proxy URL) | Sees the plaintext of every HTTP request and the `CONNECT` targets of every HTTPS one. It is an **open proxy on `127.0.0.1` inside the container**. | Nothing. Logs print `http://user:***@host:port`. |
| **Your upstream proxy or VPN** | Sees the exit traffic and, for plain HTTP, its content. | Per its own policy. |
| **Sites you visit** | See a Chromium that passes the 13 scored vectors, the configured proxy's exit address, and whatever your client chooses to send. | Whatever they retain. Stealth is a regression gate against a fixed battery, **not** a guarantee against detection. |
| **Health and metrics** (`:9224`) | Reachable only from inside the container. | Counters and uptime. |

What this does not protect against: a client you have handed the token to, a host where `127.0.0.1` is shared with untrusted processes under `network_mode: host`, or a site that fingerprints something outside the battery. If you need egress *governance* rather than a browser, that is [fieldpass](https://github.com/askalf/fieldpass); browser-bridge is the substrate under it.

## Guarantees, and how to check them

Every row is enforced by code in this repo, and every row has a check you can run against a running container without trusting this file. `<c>` is your container name.

| Guarantee | Enforced by | Verify it |
|---|---|---|
| Runs as an unprivileged user | `USER browser` in the [`Dockerfile`](Dockerfile); the process never has root inside the container | `docker exec <c> id` → a system uid named `browser`, never `uid=0` |
| A hostname `Host` is refused without a token | `hostIsIpOrLocalhost()` in [`cdp-proxy.mjs`](cdp-proxy.mjs) preserves Chromium's own anti-DNS-rebinding posture; fuzzed in [`fuzz/cdp_guards.fuzz.js`](fuzz/cdp_guards.fuzz.js) | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: browser' http://localhost:9222/json/version` → `403` |
| With a token set, nothing without it | `presentedToken()` plus a `timingSafeEqual` over SHA-256 digests; token stripped before forwarding | `curl -s -o /dev/null -w '%{http_code}' http://localhost:9222/json/version` → `401`; add `?token=…` → `200` |
| CDP WebSockets accept loopback origins only | `--remote-allow-origins` defaults to loopback, not `*` ([`launch.mjs`](launch.mjs)) | `docker exec <c> sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null \| tr "\0" " " \| grep -o -- "--remote-allow-origins=[^ ]*" \| head -1'` |
| The browser makes no background calls of its own | `--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync` in `COMMON_ARGS` | Same command as above, grep for `--disable-background-networking` |
| A proxy password never reaches stdout | Redaction in [`proxy-auth-relay.mjs`](proxy-auth-relay.mjs), asserted by a test | `docker logs <c> 2>&1 \| grep -c "$PROXY_PASS"` → `0` |
| Failover never fires on a proxy's answer | Error-code match on unreachability only; a `407` is relayed verbatim ([`test/proxy-auth-relay.test.mjs`](test/proxy-auth-relay.test.mjs) asserts the `407` and oversized-head cases) | `npm test` |
| Health reflects the browser, not a TCP port | `/healthz` checks the CDP connection and a cached deep page-load; the Docker `HEALTHCHECK` hits it | `docker exec <c> curl -s http://127.0.0.1:9224/healthz` → `{"ok":true,"connected":true,"pageCheck":"ok",…}` |
| Health and metrics are not reachable from outside | Bound to `127.0.0.1` inside the container; the image `EXPOSE`s 9222 and 9225 only | `docker port <c>` lists no 9224 |
| One profile directory, the one you configured | `buildLaunchOptions()` throws if `--user-data-dir` appears in args ([`launch-opts.mjs`](launch-opts.mjs)); [`test/launch-opts.test.mjs`](test/launch-opts.test.mjs) asserts a single profile source | Startup log line `[browser-bridge] profile: /home/browser/data`; `docker exec <c> ls /home/browser/data/Default` |
| A killed container does not wedge its volume | `clearStaleSingletonLock()` removes Chromium's three singleton entries before launch ([`profile-lock.mjs`](profile-lock.mjs)) | `docker kill <c>`, then recreate with the same volume; it starts |
| Isolated sessions cannot exhaust the host | `BRIDGE_MAX_SESSIONS` (default 20); acquisitions past it get `503` ([`session-broker.mjs`](session-broker.mjs)) | Open 21 connections in isolated mode; the 21st is refused |
| The image you pull is the image CI built | Keyless Sigstore provenance attested in [`release.yml`](.github/workflows/release.yml); the bundle is attached to every release | `gh attestation verify oci://ghcr.io/askalf/browser-bridge:v0.5.1 --owner askalf` |
| The image builds from the committed lockfile on a pinned base | `npm ci --omit=dev`; `FROM node:26-slim@sha256:…`; Dependabot refreshes the digest | Read the first 30 lines of the [`Dockerfile`](Dockerfile) |
| Stealth does not regress silently | [`stealth.yml`](.github/workflows/stealth.yml) fails below the floor and publishes the score to the `badges` branch | Run it yourself: `node stealth-score.mjs --cdp http://localhost:9222` from a clone after `npm ci` |
| The container boots, not just builds | Boot smoke in [`build.yml`](.github/workflows/build.yml) waits for `stealth Chromium running` | [build runs](https://github.com/askalf/browser-bridge/actions/workflows/build.yml) |

Four honest caveats. **`--no-sandbox` is on**: Chromium's setuid sandbox cannot run in an unprivileged container, so the sandbox is the container's user namespace plus the non-root user, not Chromium's own. **CDP is open by default**: without `BRIDGE_TOKEN`, anyone who can reach the port owns the browser; bind it to a private network, and never to the public internet, token or not. **The relay is an open proxy on loopback**: fine when the container is the trust boundary, which is the normal case, and wrong under host networking on a shared machine. **`--disable-component-update` also stops CRLSet**: a container left running for a very long time stops receiving certificate-revocation data; restart it periodically if that matters to you.

## Architecture

```mermaid
flowchart LR
    C["CDP client<br/>Playwright · Puppeteer · raw WS"] -->|":9222"| P["cdp-proxy.mjs<br/>token · Host gate · origin lock"]
    M["MCP client"] -->|":9225 /mcp"| S["mcp-server.mjs<br/>6 tools, CDP client of the bridge"]
    S --> P
    P -->|"shared"| B["Chromium<br/>127.0.0.1 · non-root · stealth"]
    P -->|"isolated ?session="| K["session-broker.mjs<br/>one Chromium per connection, cap + idle reap"]
    K --> B2["Chromium ×N"]
    B --> R["proxy-auth-relay.mjs<br/>127.0.0.1, only with user:pass"]
    R -->|"Proxy-Authorization"| U["upstream proxy / VPN"]
    U --> W["the web"]
    B -.->|"/healthz /metrics"| H[":9224 container-internal"]
```

- **Launcher** ([`launch.mjs`](launch.mjs)) starts Chromium through puppeteer-extra with the full stealth evasion set and a realistic argument set: 1920×1080 window, `en-US,en`, WebGL and accelerated canvas on, font hinting set, `--enable-automation` gone. The user-agent pool is derived at startup from `chromium --version` ([`ua.mjs`](ua.mjs)) so a UA can never claim a version the engine is not.
- **Proxy** ([`cdp-proxy.mjs`](cdp-proxy.mjs)) fronts Chromium's loopback debugger on `0.0.0.0:9222`. It is a byte pipe with three checks at the door: token, `Host`, and the WebSocket URL. Chromium rejects DNS names in `Host`, which is why remote CDP usually means digging up a container IP; the proxy presents loopback upstream so `connectOverCDP('http://browser:9222')` works by service name once auth is on.
- **Broker** ([`session-broker.mjs`](session-broker.mjs)) is opt-in. In `isolated` mode each connection gets its own Chromium process, with a concurrency cap and an idle reaper; named sessions survive reconnects.
- **Reaper** closes idle blank tabs, pages idle past a TTL, and pages beyond a hard count, measured from last navigation so an actively reused page is never touched.
- **Health** ([`/healthz`](#health-and-metrics)) returns `503` only when the CDP connection is gone. A wedged-but-connected browser reports `"pageCheck":"degraded"`; a proxy in fallback reports `"egress":"direct"`, still `200`, so an autoheal never turns a degraded egress into a restart loop.

## Connect

### Playwright

```ts
import { chromium } from 'playwright';

const browser = await chromium.connectOverCDP('http://localhost:9222');
const ctx = browser.contexts()[0] ?? await browser.newContext();
const page = await ctx.newPage();
await page.goto('https://example.com');
console.log(await page.title());
```

### Puppeteer

```ts
import puppeteer from 'puppeteer-core';

const browser = await puppeteer.connect({ browserWSEndpoint: 'ws://localhost:9222' });
```

### With a token

```ts
// The bridge resolves the root path to the browser target server-side,
// so there is no /devtools/browser/<uuid> discovery round-trip.
const browser = await chromium.connectOverCDP('ws://browser:9222/?token=' + process.env.BRIDGE_TOKEN);
```

```bash
curl -s "http://localhost:9222/json/version?token=$BRIDGE_TOKEN"
curl -s -H "X-Bridge-Token: $BRIDGE_TOKEN" http://localhost:9222/json/list
```

The token travels as `Authorization: Bearer`, `X-Bridge-Token`, or `?token=`. With a token set you can also connect by DNS or service name; without one, set `BRIDGE_ALLOW_HOSTNAMES=1` to accept hostname `Host` headers on an open bridge and accept the DNS-rebinding trade-off that comes with it.

### Raw CDP

```bash
curl -s http://localhost:9222/json/version | jq -r .webSocketDebuggerUrl
# ws://localhost:9222/devtools/browser/4b3f...
```

```jsonc
{ "id": 1, "method": "Page.navigate", "params": { "url": "https://example.com" } }
```

See the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) reference for the method surface.

### From other Own Your Stack tools

[hands](https://github.com/askalf/hands) fetches pages over plain HTTP; point its `read_page` at `BROWSER_BRIDGE_URL` and it gets a real Chromium for JS-heavy pages and servers that bounce non-browser user agents. [deepdive](https://github.com/askalf/deepdive) launches a local Playwright Chromium by default; swap `chromium.launch()` for `chromium.connectOverCDP(process.env.BROWSER_BRIDGE_URL)` and many runs share one bridge. The bridge already ships the stealth arguments deepdive lists locally, so drop them when connected. Most MCP browser servers accept a `browserURL`; point it at the bridge.

## Egress through a proxy

### VPN sidecar

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

### Authenticated proxy

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    shm_size: '512m'
    environment:
      HTTPS_PROXY: http://${PROXY_USER}:${PROXY_PASS}@proxy.example.net:8080
```

Chromium strips credentials out of `--proxy-server` and waits for a human to answer the `407`. When credentials are present, browser-bridge starts a small relay on an ephemeral loopback port, points Chromium at it, and adds `Proxy-Authorization` to every forwarded request and every `CONNECT`. A non-200 from upstream is relayed verbatim, so a wrong password surfaces as the proxy's own `407`. Per-hop headers are stripped in both directions. Credentials are percent-decoded, so a password containing `@` or `:` survives. Authenticated `https://` proxy URLs (TLS to the proxy itself) are rejected at startup rather than at first navigation.

### When the proxy goes away

```yaml
    environment:
      HTTPS_PROXY: http://${PROXY_USER}:${PROXY_PASS}@proxy.example.net:8080
      PROXY_FALLBACK: direct           # keep browsing if the proxy dies
      PROXY_CONNECT_TIMEOUT_MS: '8000' # how long before a silent tunnel counts as dead
```

**Decide this per deployment.** Going direct means the same browser, carrying the same logged-in cookies, suddenly appears from a different address and ASN, which is the shape of event that trips an account security challenge. If the proxy is there for its exit address, an outage is better than a silent relocation. If it is the only route out, failing over is obviously right.

- **Only unreachability counts.** Connection refused, host or network unreachable, DNS failure, reset before the tunnel is up, connect timeout.
- **Never an answer.** A `407`, a refused `CONNECT`, any status the proxy sends is the proxy working and saying no.
- **The timeout is what fires in real life.** A tunnel whose far end has vanished swallows packets rather than refusing them; `PROXY_CONNECT_TIMEOUT_MS` is armed only until the TCP connect lands, so it can never truncate a long-lived tunnel.
- **One failure trips the breaker.** Subsequent requests go direct immediately; the relay re-probes upstream after 30 s and returns to it as soon as it answers.

Degradation is reported, never gated on: `/healthz` shows `"egress":"direct"` and `"degraded":true` at `200`, and `/metrics` counts `proxyFallbacks`.

## Session isolation

By default every client connects to **one** Chromium: cheap, and a client that calls `browser.close()` takes the browser down for everyone. When independent clients share a bridge, set `BRIDGE_SESSION_MODE=isolated` and each connection gets its own stealth Chromium process:

```yaml
services:
  browser:
    image: ghcr.io/askalf/browser-bridge:latest
    environment:
      BRIDGE_SESSION_MODE: isolated
      BRIDGE_MAX_SESSIONS: "20"
    expose: ["9222"]
    shm_size: '512m'
```

```ts
// Ephemeral: a fresh browser for this connection, disposed on disconnect.
await chromium.connectOverCDP('http://browser:9222');

// Named: reused across reconnects until it goes idle, for a long-lived logged-in session.
await puppeteer.connect({ browserWSEndpoint: 'ws://browser:9222/?session=my-login' });
```

No client sees or closes another's targets. Every session launches through the same stealth configuration. The proxy still routes bytes; there is no per-message parsing. Named sessions are reaped after `BRIDGE_SESSION_IDLE_MS` (default 5 min) without a connection. Each session is a Chromium process, so size `BRIDGE_MAX_SESSIONS` to your RAM.

## MCP endpoint

[`mcp-server.mjs`](mcp-server.mjs) is a thin MCP server that is itself a CDP client of the bridge, so any MCP client can drive a browser with no Puppeteer or CDP code of its own. Six tools over Streamable HTTP:

| Tool | Does |
|---|---|
| `browser_navigate` | Go to a URL, wait for load, report status and title |
| `browser_screenshot` | PNG of the viewport, or `fullPage` |
| `browser_evaluate` | Run a JS expression in the page and return the result |
| `browser_get_content` | The page as `html` or visible `text` |
| `browser_get_console` | Console and page-error messages captured this session |
| `browser_pdf` | Render the page to a PDF resource |

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
      # BRIDGE_TOKEN: ${BRIDGE_TOKEN}   # required on MCP requests, presented onward to the bridge
    ports: ["9225:9225"]
```

Point a client at `http://<host>:9225/mcp`. Each MCP session opens one bridge connection as `?session=mcp-<id>`, so with the bridge in isolated mode every MCP session has its own browser. The browser opens lazily on the first tool call and is disposed when the MCP session ends.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `BRIDGE_TOKEN` | unset | Shared secret required on every CDP request and WebSocket when set. Unset = open. |
| `BRIDGE_ALLOW_HOSTNAMES` | unset | Accept DNS-name `Host` headers **without** a token. Not needed with `BRIDGE_TOKEN`. Opt-in because Chromium's `Host` check doubles as DNS-rebinding protection. |
| `CDP_ALLOWED_ORIGIN` | loopback origins | Comma-separated `Origin` values allowed on CDP WebSockets (`--remote-allow-origins`). Playwright and Puppeteer send no `Origin` and need nothing here. |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Outbound proxy for Chromium. Accepts `http://user:pass@host:port`. `HTTPS_PROXY` wins if both are set. |
| `PROXY_FALLBACK` | `off` | `direct` = retry an unreachable upstream straight out of the container. Only applies to a credentialed proxy URL. Never on a `407`. |
| `PROXY_CONNECT_TIMEOUT_MS` | `8000` | TCP connect timeout to the upstream proxy. Only used with `PROXY_FALLBACK=direct`. |
| `BRIDGE_SESSION_MODE` | `shared` | `shared` = one browser for all clients. `isolated` = a browser per connection. |
| `BRIDGE_MAX_SESSIONS` | `20` | *(isolated)* Concurrent-session cap; past it, `503`. |
| `BRIDGE_SESSION_IDLE_MS` | `300000` | *(isolated)* Reap a session this long after its last connection closes. |
| `BRIDGE_USER_DATA_DIR` | `/home/browser/data` | *(shared)* Chromium profile directory. Mount a volume there to persist cookies and storage; stale singleton locks from a killed container are cleared at startup. Isolated mode ignores this. |
| `BRIDGE_HEALTH_PORT` | `9224` | Health and metrics port, bound to `127.0.0.1` inside the container. |
| `BRIDGE_REAP_INTERVAL_MS` | `30000` | How often the page and session reaper runs. |
| `BRIDGE_BLANK_TTL_MS` | `120000` | *(shared)* Reap `about:blank` tabs idle this long. |
| `BRIDGE_MAX_IDLE_MS` | `900000` | *(shared)* Reap any page with no navigation for this long. Raise it if clients hold pages open while working. |
| `BRIDGE_MAX_PAGES` | `25` | *(shared)* Hard page-count cap; the most-idle pages beyond it are reaped. |
| `BRIDGE_MCP_PORT` | `9225` | *(mcp-server.mjs)* Port the MCP endpoint listens on. |
| `BRIDGE_MCP_PATH` | `/mcp` | *(mcp-server.mjs)* Request path for the MCP endpoint. |
| `BRIDGE_CDP_URL` | `http://127.0.0.1:9222` | *(mcp-server.mjs)* The bridge the MCP server connects to. |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary. Rarely overridden. |

Ports: **9222** CDP (the image `EXPOSE`s it). **9224** health and metrics, container-internal. **9225** the optional MCP endpoint, only when `mcp-server.mjs` runs.

`--shm-size=512m` is not optional: Chromium's default 64 MB `/dev/shm` is too small for non-trivial pages and the symptom is a crashed tab with no useful error.

## Health and metrics

```bash
docker exec <c> curl -s http://127.0.0.1:9224/healthz
# {"ok":true,"connected":true,"pageCheck":"ok","pagesOpen":2}

docker exec <c> curl -s http://127.0.0.1:9224/metrics
# {"uptimeSec":4211,"pagesOpen":2,"pagesCreated":17,"pagesReaped":3,
#  "navCount":42,"healthChecks":280,"lastReapAt":1765500000000,
#  "authFailures":0,"hostBlocked":0,"cdpConnectionsTotal":5,
#  "cdpConnectionsActive":1,"connected":true}
```

`/healthz` returns `503` only when the CDP connection is gone. The deep check opens a throwaway context and evaluates `1+1`, refreshed at most once a minute. One heartbeat log line per minute carries the same counters; pair with `restart: unless-stopped` for self-recovery.

## Releases and supply chain

- **Tags.** `:latest` tracks `master`. `:vX.Y.Z` is a release; `:vX.Y` and `:vX` follow the latest matching release. Multi-arch: `linux/amd64` and `linux/arm64`.
- **Provenance.** Every release is attested with keyless Sigstore ([`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)), and the bundle is attached to the GitHub release. Verify before you trust: `gh attestation verify oci://ghcr.io/askalf/browser-bridge:v0.5.1 --owner askalf`. An SBOM and BuildKit provenance are pushed with the image.
- **Pins.** Base image digest-pinned; `npm ci` from the committed lockfile; every GitHub Action SHA-pinned; workflow tokens read-only by default. Dependabot refreshes all of it.
- **Analysis.** CodeQL on every push and PR. ClusterFuzzLite weekly, `npm run fuzz` locally. OpenSSF Scorecard weekly.
- **Changes.** [`CHANGELOG.md`](CHANGELOG.md) records the why as well as the what, including the bugs each release found in itself.
- **Disclosure.** See [`SECURITY.md`](SECURITY.md). Please do not open a public issue for a vulnerability.

## What it isn't

- **Not a queue.** One container is one browser (or, in isolated mode, one browser per connection up to the cap). For throughput, run several containers behind a queue.
- **Not internet-facing.** CDP was never designed for that, and a token does not change it. Private network, always.
- **Not a Chrome extension host.** Headless Chromium does not load extensions reliably.
- **Not egress governance.** It gives you a browser and tells you honestly what that browser can do. Policy over what an agent may fetch is [fieldpass](https://github.com/askalf/fieldpass).

## License

MIT. See [LICENSE](LICENSE).

## Own Your Stack

Part of **[Own Your Stack](https://github.com/askalf)**: open tools for owning your AI infrastructure instead of renting it by the token. One subscription. Your box. Your terms.

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
Built by Thomas Sprayberry.
