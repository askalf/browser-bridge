# Connecting to browser-bridge

Back to the [README](../README.md).

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

[fieldpass](../policy/) wraps the bridge with an injection firewall and action gate: set `PICKET_CDP` to the bridge's CDP URL. Anything built on Playwright can swap `chromium.launch()` for `chromium.connectOverCDP(process.env.BROWSER_BRIDGE_URL)` so many runs share one bridge. Most MCP browser servers accept a `browserURL`; point it at the bridge.

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

[`mcp-server.mjs`](../mcp-server.mjs) is a thin MCP server that is itself a CDP client of the bridge, so any MCP client can drive a browser with no Puppeteer or CDP code of its own. Nine tools over Streamable HTTP:

| Tool | Does |
|---|---|
| `browser_navigate` | Go to a URL, wait for load, report status and title |
| `browser_screenshot` | PNG of the viewport, or `fullPage` |
| `browser_evaluate` | Run a JS expression in the page and return the result |
| `browser_get_content` | The page as `html` or visible `text` |
| `browser_get_console` | Console and page-error messages captured this session |
| `browser_pdf` | Render the page to a PDF resource |
| `browser_click` | Click a CSS selector with a real mouse event, after waiting for it to be visible |
| `browser_type` | Type into a field with real key events; optionally `clear` it first and `submit` with Enter. The result reports the length, never the text |
| `browser_wait_for` | Wait for a `selector` to be visible or for `text` to appear on the page |

`browser_click` and `browser_type` go through CDP's `Input` domain, so the page sees `isTrusted: true` events with ordinary mouse and key timing. Clicking with `browser_evaluate` (`el.click()`) dispatches an untrusted event, which is one of the first things bot detection looks at.

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
