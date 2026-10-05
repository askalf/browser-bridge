# Releases and supply chain

Back to the [README](../README.md).

## Releases and supply chain

- **Tags.** Images are only built from `vX.Y.Z` tags, never from `master`. `:vX.Y.Z` is that release; `:latest`, `:vX.Y` and `:vX` point at the most recently *published* build in their scope, so pushing or rebuilding an older tag moves them back to it. Multi-arch: `linux/amd64` and `linux/arm64`.
- **Provenance.** Every release is attested with keyless Sigstore ([`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)), and the bundle is attached to the GitHub release. Verify before you trust: `gh attestation verify oci://ghcr.io/askalf/browser-bridge:v0.5.1 --owner askalf`. An SBOM and BuildKit provenance are pushed with the image.
- **Pins.** Base image digest-pinned; `npm ci` from the committed lockfile; every GitHub Action SHA-pinned; workflow tokens read-only unless a job needs more, and then granted per job where it can be. Dependabot refreshes all of it.
- **Analysis.** CodeQL on every push and PR. Jazzer.js fuzzing weekly and on PRs that touch the targets (`fuzz.yml`), a ClusterFuzzLite coverage report weekly, `npm run fuzz` locally. OpenSSF Scorecard weekly.
- **Changes.** [`CHANGELOG.md`](../CHANGELOG.md) records the why as well as the what, including the bugs each release found in itself.
- **Disclosure.** See [`SECURITY.md`](../SECURITY.md). Please do not open a public issue for a vulnerability.
