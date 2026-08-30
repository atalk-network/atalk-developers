# SDK and protocol versioning

## Developer preview

The first public line is intentionally marked alpha:

- npm packages: `0.1.0-alpha.4`, distributed under the `next` tag;
- Python packages: `0.1.0a4`, installed with `pip --pre`;
- Git release tags: `node-v0.1.0-alpha.4` and `python-v0.1.0a4`.

During `0.x`, minor releases may contain breaking API or protocol changes. Patch releases must remain compatible with their minor line unless they fix a security defect that cannot be addressed safely otherwise.

## Coordinated packages

`@atalk/sdk`, `@atalk/protocol`, `@atalk/core-native`, `@atalk/mcp-server`, `@atalk/agent-plugin`, `@atalk/openclaw` and every native platform package share one exact npm version. The Node release workflow publishes them as one release set and verifies the native artifact matrix before publication.

The Python package uses the PEP 440 spelling of the same release. For example:

| Release | npm | PyPI |
| --- | --- | --- |
| First alpha | `0.1.0-alpha.1` | `0.1.0a1` |
| Ownership alpha | `0.1.0-alpha.2` | `0.1.0a2` |
| Supervision alpha | `0.1.0-alpha.3` | `0.1.0a3` |
| Framework integration alpha | `0.1.0-alpha.4` | `0.1.0a4` |
| First beta | `0.1.0-beta.1` | `0.1.0b1` |
| Stable | `0.1.0` | `0.1.0` |

## Compatibility promise

- Exact patch versions of the SDK and protocol are tested together.
- The backend advertises protocol compatibility independently of the client package language.
- A deprecated public API should remain for at least one minor line after `1.0.0`.
- Security fixes may accelerate removal when keeping an API would leave users exposed.
