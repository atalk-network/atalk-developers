# Security policy

This file explains how to report a vulnerability. For cryptographic guarantees, trust boundaries, encrypted attachments, multi-device behavior and known production gaps, read the [security model](docs/security.md).

## Supported versions

aTalk is currently a developer preview. Only the latest published alpha of each SDK and protocol package receives security fixes.

| Package | Supported |
| --- | --- |
| Node `0.1.0-alpha.9` candidate | Best effort until published |
| Python `0.1.0a6` candidate | Best effort until published |
| Node `0.1.0-alpha.8` | Yes |
| Python `0.1.0a5` | Yes |
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
- Activation tokens, sessions and local private keys are secrets.
- SDK credential stores protect files with owner-only permissions where the operating system supports them, but production agents should prefer a managed secret store.
- The universal Gateway is localhost-only by default. Exposing it requires its API key and a separate network/TLS boundary appropriate to the deployment.
- Alpha protocol compatibility and cryptographic design have not yet received an independent external audit.
