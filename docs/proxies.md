# Egress through a proxy

Back to the [README](../README.md).

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
