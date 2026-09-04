# aTalk public developer ecosystem

The application, backend and deployment infrastructure remain private during the developer preview.
The buildable protocol, portable core, SDKs and agent integrations are published at
[`atalk-network/atalk-developers`](https://github.com/atalk-network/atalk-developers) under
Apache-2.0.

The private product monorepo remains the implementation source of truth. Every public release must
export the following source and canonical documentation paths before its version tags are created:

```text
core/protocol
core/rust
core/node-native
core/mobile-ffi
sdk/node
sdk/python
integrations/gateway
integrations/openclaw
integrations/hermes
integrations/mcp
integrations/agent-plugin
docs/integrations.md
docs/agent-multimedia.md
docs/protocol.md
docs/security.md
docs/architecture.md
docs/permissions.md
docs/agent-ownership.md
docs/supervision-and-temporary-authorizations.md
docs/device-sessions.md
docs/discovery-and-privacy.md
docs/workrooms-and-mandates.md
docs/workrooms-ui-contract.md
docs/adr/0005-encrypted-workrooms-and-signed-mandates.md
docs/sdk-versioning.md
docs/registry-setup.md
Cargo.toml
Cargo.lock
tsconfig.base.json
CHANGELOG.md
```

The public root `package.json`, `pnpm-workspace.yaml`, `README.md`, `LICENSE`, `SECURITY.md` and
`CONTRIBUTING.md` are intentionally public-repository wrappers; they are reviewed and updated rather
than copied from the private product root. In particular, the public repository is wholly
Apache-2.0, while the product monorepo has a split license and private application workspaces. After
each export, regenerate `pnpm-lock.yaml` from the public workspace. Never copy the private lockfile or
workspace manifest verbatim. The public CI/release workflows and helper scripts are also maintained
against this smaller workspace: merge relevant release changes into them, but do not replace them
with private backend/mobile workflows. `scripts/check-doc-links.mjs` verifies this public tree before
tagging.

Package metadata, changelogs and documentation links must point to that public URL. The exported
commit must contain the exact source and docs represented by each release tag so npm/PyPI provenance
never points to older behavior.

In particular, a release that advertises multi-participant Tasks must include the Workroom protocol,
both SDK clients, Gateway/OpenClaw/Hermes/MCP support and the two public Task documents above. The
landing must not link a new document until the corresponding public commit is reachable without
authentication.

## Publication order

Node releases are immutable and must run in this order:

1. build and test every configured Rust target;
2. publish `@atalk/protocol`;
3. publish all `@atalk/core-native-*` target packages;
4. publish `@atalk/core-native`;
5. install the published native package on representative runners;
6. publish `@atalk/sdk` under the `next` tag;
7. build, test and publish the Gateway, OpenClaw, MCP and portable Agent Plugin under the same `next` version.

Python releases build one source distribution and one universal wheel, validate both, then publish through PyPI Trusted Publishing.

## Registry ownership

- The `@atalk` npm organization and coordinated alpha packages are active.
- The `atalk-sdk` and `atalk-hermes` PyPI projects are active.
- Protect registry accounts with passkeys or two-factor authentication.
- Require manual approval on the GitHub `npm` and `pypi` environments.
- Use OIDC trusted publishing with provenance. Do not reintroduce long-lived npm or PyPI tokens.

## Public-link release gate

Before deploying landing or `llms*.txt` changes, verify at minimum:

- repository root and the exact Node/Python release tags;
- architecture, security, protocol, integrations, device, privacy and Task documentation URLs;
- npm and PyPI package pages referenced by the landing;
- all local canonical, `hreflang`, sitemap and media URLs.

A missing public document is a release blocker, not a reason to remove the local documentation from
the export. This keeps both human readers and AI/search crawlers on the same versioned contract.

## Expo audit isolation

The public release jobs install only the protocol, native core and SDK dependency subgraph. Mobile/Expo advisories are audited and remediated in the private application pipeline and cannot become dependencies of the public packages.
