# Contributing to fieldpass

Thanks for your interest in improving **fieldpass** — own your agent browser: an
indirect-prompt-injection firewall and action gate that wraps any CDP browser so
an agent can read untrusted web pages safely. Part of the Own Your Stack
agent-security suite — part of
[Own Your Agent Security](https://sprayberrylabs.com).

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — follow
  [SECURITY.md](SECURITY.md) to report it privately.

## Development setup

fieldpass is a Node.js package. You need Node.js **20 or 22** (the versions CI
tests against).

```bash
git clone https://github.com/askalf/fieldpass.git
cd fieldpass
npm ci        # install dependencies
npm test      # run the test suite (node --test)
```

The CDP driver and the Claude-backed judge are **optional** dependencies: the
test suite doesn't need them, and CI installs with
`npm ci --omit=optional --no-audit --no-fund`.

## Making a change

1. Branch off `main`.
2. Keep the change focused — one concern per PR.
3. Add or update tests for any behavior change. fieldpass sits on a trust
   boundary, so changes to the injection firewall, the action gate, or the
   broker / escalation paths must be covered by tests.
4. Run `npm test` locally before pushing.
5. Open a pull request against `main`.

## What CI requires

Every PR must pass these checks to merge:

- `test` (ubuntu-latest, Node **22**) and `test-node20` (ubuntu-latest,
  Node **20**) — the engines floor is exercised in a separate job so `test`
  stays a single required-status context
- **CodeQL** static analysis (`analyze (javascript-typescript)`)

OpenSSF Scorecard also runs on the repo; a new high-severity finding will block
the change.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or
  updated workflow steps must keep this.
- Commit messages: short imperative subject, with a wrapped body explaining the
  *why* when it isn't obvious.
- PRs are squash-merged, so your PR title becomes the commit subject on `main`.
