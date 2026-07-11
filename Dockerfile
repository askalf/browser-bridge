# browser-bridge — stealth headless Chromium exposing CDP on port 9222.
# Drop-in target for any Playwright / Puppeteer / MCP / agent client
# that wants to connect to a remote Chromium without running the browser
# itself.
#
# Image size ~600MB — chromium itself + node:22-slim + puppeteer-extra
# stealth deps. We build under non-root `browser` so the running process
# isn't privileged.
FROM node:26-slim

LABEL org.opencontainers.image.source="https://github.com/askalf/browser-bridge"
LABEL org.opencontainers.image.description="browser-bridge — stealth headless Chromium exposing CDP on port 9222"
LABEL org.opencontainers.image.licenses="MIT"

# Install Chromium + supporting fonts + ca-certs (HTTPS) + curl (used by
# the healthcheck). The loopback->wildcard CDP forward is handled by the
# launcher's built-in proxy (cdp-proxy.mjs) — no socat needed.
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
      chromium \
      fonts-liberation \
      fonts-noto-color-emoji \
      ca-certificates \
      curl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install puppeteer-extra + stealth plugin. We pin major versions; the
# CI release pipeline will rebuild on dependabot bumps so transitive
# updates land regularly.
COPY package.json package-lock.json* /app/
RUN npm install --omit=dev

COPY launch.mjs cdp-proxy.mjs mcp-server.mjs /app/

# Run as a non-root user so a CDP escape can't escalate.
RUN groupadd -r browser && useradd -r -g browser browser && \
    mkdir -p /home/browser/data && chown -R browser:browser /home/browser /app

USER browser

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

EXPOSE 9222
# 9225 — optional MCP endpoint (mcp-server.mjs). Run it as a second process
# alongside the bridge: `command: ["node", "/app/mcp-server.mjs"]`. See README.
EXPOSE 9225

# Chromium binds the debugger to 127.0.0.1 by default on newer versions;
# the built-in CDP proxy fronts it on 0.0.0.0:9222 so other containers can
# reach it. The healthcheck hits /healthz on :9224 (container-internal),
# which checks the CDP connection itself — not just TCP liveness — and
# carries a deep page-load check in its body.
HEALTHCHECK --interval=15s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:9224/healthz || exit 1

CMD ["node", "/app/launch.mjs"]
