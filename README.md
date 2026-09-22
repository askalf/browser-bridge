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

- **The stealth score is measured, not asserted.** On every relevant push and PR, CI builds the image, drives it as an ordinary CDP client, and evaluates the bot-detection vectors that sannysoft and CreepJS probe, in-page, with no network ([`stealth-score.mjs`](stealth-score.mjs)). The stealth badge above is that live number, and the build fails if it drops below the floor.
- **CDP gets an auth story.** Set `BRIDGE_TOKEN` and every request and WebSocket upgrade must present it. The compare is constant-time over a SHA-256 digest, the token is stripped before anything reaches Chromium, and failures are counted in `/metrics`. Off by default, and the docs say so rather than hiding it.
- **The trust boundary is fuzzed.** ClusterFuzzLite runs two Jazzer.js targets weekly against the proxy's pure request guards and the user-agent picker ([`fuzz/`](fuzz)): the DNS-rebinding gate never passes a hostname, `?token=` never survives into the forwarded path, auth headers never leak upstream. OpenSSF Scorecard **Fuzzing**, **Pinned-Dependencies**, and **Token-Permissions** all score 10.
- **Authenticated proxies just work.** Chromium discards the `user:pass` in `--proxy-server` and expects a human to answer the `407`. browser-bridge stands up a loopback relay that adds `Proxy-Authorization` on the browser's behalf, without `page.authenticate()`, so your CDP client keeps the `Fetch` domain to itself. The password never reaches the logs.
- **Failover is a deliberate choice, off by default.** `PROXY_FALLBACK=direct` retries an *unreachable* proxy straight out of the container. It never fails over on a `407` or any other answer the proxy sends, because turning a wrong password into a silent change of exit address is worse than an outage.
- **Isolated sessions and an MCP endpoint.** `BRIDGE_SESSION_MODE=isolated` gives each connection its own stealth Chromium; `mcp-server.mjs` exposes six browser tools to any MCP client.
- **The container has to boot, not just build.** CI runs the image and waits for the post-launch marker. This exists because v0.3.0 shipped an image that built clean and crashed on start; the guard has been there since.
- **The browser's own chatter stays home.** GCM, component update, domain-reliability beacons, and Sync are disabled at launch, so a metered or residential proxy carries only the traffic your client asked for.
- **Unit tests with no Docker required.** `npm test` runs the proxy, relay, broker, MCP server, profile lock, and UA suites against fakes and stubs, in seconds.

## Reference

- **[Security model](docs/security-model.md)**: who can do what on the path, every guarantee with a command to check it against a running container, and the four honest caveats (`--no-sandbox`, CDP open by default, the loopback relay, CRLSet).
- **[Connect](docs/connect.md)**: Playwright, Puppeteer, token auth, raw CDP, other Own Your Stack tools, session isolation, and the MCP endpoint.
- **[Egress through a proxy](docs/proxies.md)**: VPN sidecar, authenticated proxies, and when to fail over.
- **[Configuration](docs/configuration.md)**: every env var, the ports, `--shm-size`, health and metrics.
- **[Architecture](docs/architecture.md)**: the launcher, proxy, broker, reaper and health check, with a diagram.
- **[Releases and supply chain](docs/releases.md)**: tags, provenance verification, pins, analysis.
- [CHANGELOG.md](CHANGELOG.md) · [SECURITY.md](SECURITY.md)

## What it isn't

- **Not a queue.** One container is one browser (or, in isolated mode, one browser per connection up to the cap). For throughput, run several containers behind a queue.
- **Not internet-facing.** CDP was never designed for that, and a token does not change it. Private network, always.
- **Not a Chrome extension host.** Headless Chromium does not load extensions reliably.
- **Not egress governance.** It gives you a browser and tells you honestly what that browser can do. Policy over what an agent may fetch is [fieldpass](policy/).

### The policy layer lives here now

fieldpass's source is the [`policy/`](policy/) directory of this repository. The npm package is unchanged: `npm i @askalf/fieldpass` (or `npx -y @askalf/fieldpass scan <url>`). Same bins, env vars and MCP tool names; only the repo moved. See [`policy/README.md`](policy/README.md).

## License

MIT. See [LICENSE](LICENSE).

## Own Your Stack

Part of **[Own Your Stack](https://github.com/askalf)**: open tools for owning your AI infrastructure instead of renting it by the token. One subscription. Your box. Your terms.

- **[dario](https://github.com/askalf/dario)** — own your routing
- **[hybrid](https://github.com/askalf/hybrid)** — own your inference
- **[browser-bridge](https://github.com/askalf/browser-bridge)** — own your browser _(you are here)_
- **[redstamp](https://github.com/askalf/redstamp)** — own your agent security
- **[truecopy](https://github.com/askalf/truecopy)** — own your agent skills
- **[cordon](https://github.com/askalf/cordon)** — own your prompts
- **[fieldpass](policy/)** — own your agent browser
- **[amnesia](https://github.com/askalf/amnesia)** — own your search
- **[askalf](https://askalf.org)** — own your operation: the AI operation that runs Sprayberry Labs

---
Built by Thomas Sprayberry.
