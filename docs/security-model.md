# browser-bridge security model

Back to the [README](../README.md).

Who sits on the path, what each can do, and a check you can run for every guarantee.

## Who can do what

A remote browser is a remote shell with a rendering engine. This is who sits on the path and what each party can do, in the default deployment (a private Docker network, no token). "Stores" means retained after the request.

| Party | Can do | Stores |
|---|---|---|
| **Anyone who can reach `:9222`** | Everything CDP allows: navigate anywhere, read every page, run script, read cookies the browser holds, take screenshots. With `BRIDGE_TOKEN` set, nothing without the token (`401`); with a hostname `Host` and no token, nothing (`403`). | Nothing on the bridge. |
| **The CDP proxy** ([`cdp-proxy.mjs`](../cdp-proxy.mjs)) | Sees every request and WebSocket frame as bytes. Checks the token, gates the `Host`, rewrites `Host` to loopback, strips the token, and pipes. No per-message CDP parsing on the hot path. | Counters only (`authFailures`, `hostBlocked`, connections). |
| **Chromium** (`browser` user, `--no-sandbox`) | Whatever a page can do inside a Chromium process. Escapes land as the unprivileged `browser` user inside the container; the container is the sandbox. | The profile at `BRIDGE_USER_DATA_DIR` in shared mode (cookies, storage), which persists only if you mount a volume there. Isolated sessions use a fresh directory that is deleted on close. |
| **The auth relay** ([`proxy-auth-relay.mjs`](../proxy-auth-relay.mjs), only with a credentialed proxy URL) | Sees the plaintext of every HTTP request and the `CONNECT` targets of every HTTPS one. It is an **open proxy on `127.0.0.1` inside the container**. | Nothing. Logs print `http://user:***@host:port`. |
| **Your upstream proxy or VPN** | Sees the exit traffic and, for plain HTTP, its content. | Per its own policy. |
| **Sites you visit** | See a Chromium that passes the 13 scored vectors, the configured proxy's exit address, and whatever your client chooses to send. | Whatever they retain. Stealth is a regression gate against a fixed battery, **not** a guarantee against detection. |
| **Health and metrics** (`:9224`) | Reachable only from inside the container. | Counters and uptime. |

What this does not protect against: a client you have handed the token to, a host where `127.0.0.1` is shared with untrusted processes under `network_mode: host`, or a site that fingerprints something outside the battery. If you need egress *governance* rather than a browser, that is [fieldpass](../policy/); browser-bridge is the substrate under it.

## Guarantees, and how to check them

Every row is enforced by code in this repo, and every row has a check you can run against a running container without trusting this file. `<c>` is your container name.

| Guarantee | Enforced by | Verify it |
|---|---|---|
| Runs as an unprivileged user | `USER browser` in the [`Dockerfile`](../Dockerfile); the process never has root inside the container | `docker exec <c> id` → a system uid named `browser`, never `uid=0` |
| A hostname `Host` is refused without a token | `hostIsIpOrLocalhost()` in [`cdp-proxy.mjs`](../cdp-proxy.mjs) preserves Chromium's own anti-DNS-rebinding posture; fuzzed in [`fuzz/cdp_guards.fuzz.js`](../fuzz/cdp_guards.fuzz.js) | `curl -s -o /dev/null -w '%{http_code}' -H 'Host: browser' http://localhost:9222/json/version` → `403` |
| With a token set, nothing without it | `presentedToken()` plus a `timingSafeEqual` over SHA-256 digests; token stripped before forwarding | `curl -s -o /dev/null -w '%{http_code}' http://localhost:9222/json/version` → `401`; add `?token=…` → `200` |
| CDP WebSockets accept loopback origins only | `--remote-allow-origins` defaults to loopback, not `*` ([`launch.mjs`](../launch.mjs)) | `docker exec <c> sh -c 'cat /proc/[0-9]*/cmdline 2>/dev/null \| tr "\0" " " \| grep -o -- "--remote-allow-origins=[^ ]*" \| head -1'` |
| The browser makes no background calls of its own | `--disable-background-networking --disable-component-update --disable-domain-reliability --disable-sync` in `COMMON_ARGS` | Same command as above, grep for `--disable-background-networking` |
| A proxy password never reaches stdout | Redaction in [`proxy-auth-relay.mjs`](../proxy-auth-relay.mjs), asserted by a test | `docker logs <c> 2>&1 \| grep -c "$PROXY_PASS"` → `0` |
| Failover never fires on a proxy's answer | Error-code match on unreachability only; a `407` is relayed verbatim ([`test/proxy-auth-relay.test.mjs`](../test/proxy-auth-relay.test.mjs) asserts the `407` and oversized-head cases) | `npm test` |
| Health reflects the browser, not a TCP port | `/healthz` checks the CDP connection and a cached deep page-load; the Docker `HEALTHCHECK` hits it | `docker exec <c> curl -s http://127.0.0.1:9224/healthz` → `{"ok":true,"connected":true,"pageCheck":"ok",…}` |
| Health and metrics are not reachable from outside | Bound to `127.0.0.1` inside the container; the image `EXPOSE`s 9222 and 9225 only | `docker port <c>` lists no 9224 |
| One profile directory, the one you configured | `buildLaunchOptions()` throws if `--user-data-dir` appears in args ([`launch-opts.mjs`](../launch-opts.mjs)); [`test/launch-opts.test.mjs`](../test/launch-opts.test.mjs) asserts a single profile source | Startup log line `[browser-bridge] profile: /home/browser/data`; `docker exec <c> ls /home/browser/data/Default` |
| A killed container does not wedge its volume | `clearStaleSingletonLock()` removes Chromium's three singleton entries before launch ([`profile-lock.mjs`](../profile-lock.mjs)) | `docker kill <c>`, then recreate with the same volume; it starts |
| Isolated sessions cannot exhaust the host | `BRIDGE_MAX_SESSIONS` (default 20); acquisitions past it get `503` ([`session-broker.mjs`](../session-broker.mjs)) | Open 21 connections in isolated mode; the 21st is refused |
| The image you pull is the image CI built | Keyless Sigstore provenance attested in [`release.yml`](../.github/workflows/release.yml); the bundle is attached to every release | `gh attestation verify oci://ghcr.io/askalf/browser-bridge:v0.5.1 --owner askalf` |
| The image builds from the committed lockfile on a pinned base | `npm ci --omit=dev`; `FROM node:26-slim@sha256:…`; Dependabot refreshes the digest | Read the first 30 lines of the [`Dockerfile`](../Dockerfile) |
| Stealth does not regress silently | [`stealth.yml`](../.github/workflows/stealth.yml) fails below the floor and publishes the score to the `badges` branch | Run it yourself: `node stealth-score.mjs --cdp http://localhost:9222` from a clone after `npm ci` |
| The container boots, not just builds | Boot smoke in [`build.yml`](../.github/workflows/build.yml) waits for `stealth Chromium running` | [build runs](https://github.com/askalf/browser-bridge/actions/workflows/build.yml) |

Four honest caveats. **`--no-sandbox` is on**: Chromium's setuid sandbox cannot run in an unprivileged container, so the sandbox is the container's user namespace plus the non-root user, not Chromium's own. **CDP is open by default**: without `BRIDGE_TOKEN`, anyone who can reach the port owns the browser; bind it to a private network, and never to the public internet, token or not. **The relay is an open proxy on loopback**: fine when the container is the trust boundary, which is the normal case, and wrong under host networking on a shared machine. **`--disable-component-update` also stops CRLSet**: a container left running for a very long time stops receiving certificate-revocation data; restart it periodically if that matters to you.
