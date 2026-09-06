#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# Each target is an ESM module exporting a synchronous `fuzz(data)`, and each
# asserts a fail-safe contract at fieldpass's trust boundary — the detector
# never crashes on a hostile page (a crashed detector fails OPEN), the
# provenance fence around untrusted page text can never be forged or dissolved,
# and the action gate stays default-deny for an agent already under influence.
cd "$SRC/fieldpass"

# fieldpass ships a committed package-lock.json, so install from it for a
# reproducible fuzz build. @jazzer.js/core is a pinned devDependency (exact
# 4.0.0) and is excluded from the published package by the "files" allowlist in
# package.json, which covers only src/ and bin/.
npm ci --no-audit --no-fund

# --sync: every target's fuzz() is synchronous (captureFromHtml, detect,
# buildSafeObservation and gate are all sync). An async target would omit this.
for target in capture_detect neutralize_fence action_gate; do
  compile_javascript_fuzzer fieldpass "fuzz/${target}.fuzz.js" --sync
done
