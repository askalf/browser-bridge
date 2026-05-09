## Summary

<!-- 1-3 bullets on what this PR does and why. Skip the "what changed" auto-summary — the diff already shows that. Focus on the *why*. -->

## What's NOT in this PR

<!-- Anything reviewers might expect but doesn't belong here, with a one-line reason. Optional but useful. -->

## Test plan

- [ ] CI build green (Dockerfile builds cleanly)
- [ ] If touching `launch.mjs`: smoke-test locally — `docker build -t br . && docker run --rm -p 9222:9222 --shm-size=512m br` then verify `curl localhost:9222/json/version` returns the Chromium build info
- [ ] If touching stealth evasion list: confirm puppeteer-extra-plugin-stealth still exposes those evasion names (they sometimes get renamed across major versions)
