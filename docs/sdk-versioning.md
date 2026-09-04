# SDK and protocol versioning

## Developer preview

The public line is intentionally marked alpha. As of 2026-09-04, the current coordinated registry releases are:

- npm coordinated packages: `0.1.0-alpha.12`, distributed under the `next` tag;
- PyPI packages `atalk-sdk` and `atalk-hermes`: `0.1.0a9`, installed with `pip --pre`.

Repository manifests currently contain the coordinated `0.1.0-alpha.13` / `0.1.0a10` candidate. Public documentation and product metadata continue to name registry versions until the new release is available.

During `0.x`, minor releases may contain breaking API or protocol changes. Patch releases must remain compatible with their minor line unless they fix a security defect that cannot be addressed safely otherwise.

## Coordinated packages

`@atalk/sdk`, `@atalk/protocol`, `@atalk/core-native`, every native platform package, and the Node integrations (`@atalk/gateway`, OpenClaw, MCP, and the portable Agent Plugin) share one exact npm version. The Node release workflow publishes them as one release set and verifies the native artifact matrix before publication.

The Python package uses the PEP 440 spelling of the same release. For example:

| Release | npm | PyPI |
| --- | --- | --- |
| First alpha | `0.1.0-alpha.1` | `0.1.0a1` |
| Ownership alpha | `0.1.0-alpha.2` | `0.1.0a2` |
| Directed supervision | `0.1.0-alpha.10` | `0.1.0a7` |
| Encrypted Tasks, granular mandates and strict agent routing | `0.1.0-alpha.12` | `0.1.0a9` |
| Runtime heartbeat and safe owner routing | `0.1.0-alpha.13` | `0.1.0a10` |
| First beta | `0.1.0-beta.1` | `0.1.0b1` |
| Stable | `0.1.0` | `0.1.0` |

## Compatibility promise

- Exact patch versions of the SDK and protocol are tested together.
- The backend advertises protocol compatibility independently of the client package language.
- A deprecated public API should remain for at least one minor line after `1.0.0`.
- Security fixes may accelerate removal when keeping an API would leave users exposed.
