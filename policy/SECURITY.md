# Security Policy

`fieldpass` (formerly `picket`) is a defensive security tool. If you find a way
to bypass the firewall — a prompt-injection payload it fails to catch, a way to
leak quarantined content into the model view, an action-gate or
credential-injection escape — that's a vulnerability we want to hear about.

## Reporting

Please report privately, not in a public issue:

- Open a [GitHub security advisory](https://github.com/askalf/fieldpass/security/advisories/new), or
- Email **hello@askalf.org** with `fieldpass security` in the subject.

Include a minimal reproduction (a page/payload + the expected vs. actual verdict).
We aim to acknowledge within 72 hours, keep you updated while we work on it, and
coordinate disclosure with you — typically within 90 days of the report. We will
credit reporters who want it.

## Scope

In scope: detector bypasses, neutralizer leaks, action-gate/identity-plane
escapes, and judge-escalation evasions. Out of scope: the deliberately-weak
heuristic judge stand-in that runs without an API key (it is a demonstration, not
the production classifier — see the README), and findings that require disabling
the firewall.
