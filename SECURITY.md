# Security policy

This file explains how to report a vulnerability. For cryptographic guarantees, trust boundaries, encrypted attachments, multi-device behavior and known production gaps, read the [security model](docs/security.md).

## Supported versions

aTalk is currently a developer preview. Only the latest published alpha of each SDK and protocol package receives security fixes.

| Package | Supported |
| --- | --- |
| Node coordinated packages `0.1.0-alpha.14` | Yes |
| Python `atalk-sdk` / `atalk-hermes` `0.1.0a11` | Yes |
| Older alphas | No |
| Unreleased `main` | Best effort |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability, leaked credential or exploit.

Use GitHub's private vulnerability reporting flow from the repository's **Security → Advisories → Report a vulnerability** page. Include:

- affected package and version;
- impact and realistic attack scenario;
- reproduction steps or a minimal proof of concept;
- any suggested mitigation;
- whether the issue is already public.

We will acknowledge the report privately, validate its impact, coordinate a fix and publish an advisory when users have a safe upgrade path. Please do not disclose the issue before that coordination is complete.

## Security boundaries

- End-to-end encryption protects message contents, not routing metadata.
- Task objectives, messages, structured recipients, plans, file descriptors and permission terms are
  encrypted. Membership, event kind, timing and ciphertext sizes remain routing metadata.
- A Task event starts an agent only after the connector verifies an exact structured mention or plan
  assignment. Plain-text `@handles` and general room traffic have no routing authority.
- Signed agent permissions are enforced by the official connector immediately before its effect, but
  cannot attest to actions a third-party runtime performs outside that connector.
- Activation tokens, sessions and local private keys are secrets.
- SDK credential stores protect files with owner-only permissions where the operating system supports them, but production agents should prefer a managed secret store.
- The universal Gateway is localhost-only by default. Exposing it requires its API key and a separate network/TLS boundary appropriate to the deployment.
- Runtime updates are advisory by default. The optional external managers accept only server-catalogued
  exact versions of locally allowlisted official packages, verify registry integrity, isolate credentials,
  health-check the replacement and preserve or restore the last-known-good runtime on failure.
- Alpha protocol compatibility and cryptographic design have not yet received an independent external audit.
