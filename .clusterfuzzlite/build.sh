#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# Each target is an ESM module exporting `fuzz(data)`; the invariants are the
# fail-safe contracts at browser-bridge's trust boundary — the CDP proxy's
# request guards (the DNS-rebinding gate never passes a hostname, secrets are
# always stripped/dropped before anything is forwarded to Chromium) and the
# UA pool (client-controlled session ids never break the deterministic pick).
# The repo is plain ESM — no build step, targets import the runtime modules.
cd "$SRC/browser-bridge"
npm ci --no-audit --no-fund

for target in cdp_guards ua; do
  compile_javascript_fuzzer browser-bridge "fuzz/${target}.fuzz.js" --sync
done
