# browser-bridge configuration

Back to the [README](../README.md).

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `BRIDGE_TOKEN` | unset | Shared secret required on every CDP request and WebSocket when set. Unset = open. |
| `BRIDGE_ALLOW_HOSTNAMES` | unset | `1`/`true`/`yes`/`on` = accept DNS-name `Host` headers **without** a token; anything else, `0` and `false` included, leaves it off. Not needed with `BRIDGE_TOKEN`. Opt-in because Chromium's `Host` check doubles as DNS-rebinding protection. |
| `CDP_ALLOWED_ORIGIN` | loopback origins | Comma-separated `Origin` values allowed on CDP WebSockets (`--remote-allow-origins`). Playwright and Puppeteer send no `Origin` and need nothing here. |
| `HTTPS_PROXY` / `HTTP_PROXY` | unset | Outbound proxy for Chromium. Accepts `http://user:pass@host:port`. `HTTPS_PROXY` wins if both are set. |
| `PROXY_FALLBACK` | `off` | `direct` = retry an unreachable upstream straight out of the container. Only applies to a credentialed proxy URL. Never on a `407`. |
| `PROXY_CONNECT_TIMEOUT_MS` | `8000` | How long the auth relay waits for a credentialed upstream proxy: until TCP connects for plain HTTP, and until the upstream answers the `CONNECT` for HTTPS. Applies whether or not `PROXY_FALLBACK` is on; with it on, a timeout is what triggers the fallback. |
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
| `BRIDGE_MCP_SESSION_IDLE_MS` | `1800000` | *(mcp-server.mjs)* Close an MCP session, and its browser connection, after this long with no request in flight. Covers clients that exit without sending `DELETE`. |
| `BROWSER_SESSION_ID` | unset | *(shared)* Seed for the user-agent pick, so a restarted container keeps the same UA. Unset = a new pick per process. |
| `BRIDGE_STEALTH_FLOOR` | battery size - 1 | *(stealth-score.mjs)* Minimum number of passing checks; below it the script exits non-zero. A non-integer value is an error. |
| `BRIDGE_STEALTH_OUT` | `stealth.json` | *(stealth-score.mjs)* Where the stealth score JSON is written. |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Chromium binary. Rarely overridden. |

The bridge's numeric settings must be positive integers; it refuses to start on anything else (`abc`, `0`, `8s`) rather than run with a disabled cap or a busy-looping timer.

Ports: **9222** CDP (the image `EXPOSE`s it). **9224** health and metrics, container-internal. **9225** the optional MCP endpoint, only when `mcp-server.mjs` runs.

`--shm-size=512m` is not optional: Chromium's default 64 MB `/dev/shm` is too small for non-trivial pages and the symptom is a crashed tab with no useful error.

## Health and metrics

```bash
docker exec <c> curl -s http://127.0.0.1:9224/healthz
# {"ok":true,"connected":true,"pageCheck":"ok","pagesOpen":2,"egress":"direct","degraded":false}

docker exec <c> curl -s http://127.0.0.1:9224/metrics
# {"uptimeSec":4211,"mode":"shared","navCount":42,"pagesReaped":3,
#  "healthChecks":280,"lastReapAt":1765500000000,"authFailures":0,
#  "hostBlocked":0,"cdpConnectionsTotal":5,"cdpConnectionsActive":1,
#  "egress":"direct","proxyFallbacks":0,"pagesOpen":2,"pagesCreated":17}
```

`/healthz` returns `503` only when the CDP connection is gone (shared mode) or a probe session cannot be launched (isolated mode; a broker with every slot in use reports `"pageCheck":"saturated"` at `200`). In shared mode the deep check opens a throwaway context and evaluates `1+1`, refreshed at most once a minute; in isolated mode it launches a probe session, refreshed at most every 5 minutes, so a failed probe holds `503` until the next one. One heartbeat log line per minute carries the same counters; pair with `restart: unless-stopped` for self-recovery.
