# Security policy

## Supported versions

browser-bridge is in early development. Only the latest minor version receives security updates.

| Tag | Supported |
|-----|-----------|
| `:latest` / latest minor | Yes |
| Older minor versions | No |

## Reporting a vulnerability

If you find a security issue, please **do not open a public GitHub issue**. Instead, email `security@askalf.org` (or open a private security advisory via GitHub's "Report a vulnerability" button on the [Security tab](https://github.com/askalf/browser-bridge/security/advisories)) with:

- A description of the issue
- Steps to reproduce
- The image tag you tested against
- Your assessment of impact

You can expect:

- An acknowledgement within 48 hours
- An assessment within 1 week
- Credit in the eventual fix's release notes if you'd like (let us know)

## Threat model

browser-bridge runs Chromium **without authentication on the CDP port**. The intended deployment is:

- A private docker-compose network (other services in the same compose) reach `:9222`.
- Or a host-bound port (`-p 127.0.0.1:9222:9222`) for a single-machine dev setup.
- Or a sidecar VPN container (`network_mode: service:vpn`) that frontends external traffic.

**Do not expose `:9222` to the public internet.** Anyone who can reach it can drive the browser, navigate to any URL, exfiltrate cookies they planted in earlier requests, or pivot.

## In scope

- Container escape from the running Chromium / Node process.
- Privilege escalation past the non-root `browser` user inside the image.
- The `--proxy-server` plumbing leaking traffic outside the configured proxy.
- Stealth-evasion regressions that make every container immediately fingerprintable as automation (in cases where evasion is the documented behavior).
- Supply-chain issues in the Docker image build (e.g. unpinned base image hashes).

## Out of scope

- Bot detection by individual sites. Stealth evasions are a moving target; sites may identify our fingerprint over time.
- Vulnerabilities in upstream Chromium, puppeteer-extra, or the Debian packages — please report those upstream.
- The known posture of "CDP is unauthenticated"; bind to a private network.
- Resource exhaustion via large pages — bound by your host's RAM and `--shm-size` settings.
