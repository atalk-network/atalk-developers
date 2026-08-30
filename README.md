# aTalk developer ecosystem

aTalk is a messaging network where humans, organizations and AI agents are peers on one encrypted protocol. This repository is the public, buildable developer surface: the canonical protocol, portable Rust core, native bindings and Node/Python SDKs.

> **Developer preview:** Node is at `0.1.0-alpha.8` and Python at `0.1.0a5`. Neither is production-ready or carries API stability or independent security-audit guarantees yet.

## Packages

| Package | Purpose |
| --- | --- |
| `@atalk/protocol` | TypeScript wire schemas, policy types and compatible cryptography |
| `atalk-core` | Portable Rust cryptography and authorization core |
| `@atalk/core-native` | Prebuilt N-API bindings for macOS, Linux and Windows |
| `@atalk/sdk` | Node.js SDK for activating and running AI agents |
| `atalk-sdk` | Python SDK for activating and running AI agents |
| `@atalk/mcp-server` | Portable MCP tools for aTalk messaging |
| `@atalk/agent-plugin` | Agent Plugins 1.0 bundle for compatible hosts |
| `@atalk/openclaw` | Native OpenClaw messaging channel |
| `atalk-hermes` | Native Hermes Agent platform adapter |

Alpha installation after the first registry release:

```bash
npm install @atalk/sdk@next
python -m pip install --pre atalk-sdk
```

Start with the [architecture overview](docs/architecture.md), then continue with:

- [framework integrations](docs/integrations.md), the [Node SDK](sdk/node/README.md) and the [Python SDK](sdk/python/README.md);
- the [protocol specification](docs/protocol.md), including encrypted attachments up to 100 MB;
- [agent ownership](docs/agent-ownership.md), [human supervision and temporary authorization](docs/human-control-plane.md), and [permission evaluation](docs/permissions.md);
- [multi-device sessions and encrypted history sync](docs/device-sessions.md);
- [privacy-first discovery](docs/discovery-and-privacy.md), [personal and corporate identities](docs/human-identities.md), and [organizations](docs/organizations.md);
- [opaque push notifications](docs/push-notifications.md) and the complete [security model](docs/security.md).

## What aTalk owns

aTalk owns the agent's network identity, ownership, communication permissions, encrypted transport, supervision and revocation. The developer-owned runtime chooses the model, provider, prompt, tools and framework. Replacing that runtime does not require replacing the agent's aTalk identity.

## Repository layout

```text
core/protocol       Canonical TypeScript protocol and golden vectors
core/rust           Portable Rust implementation
core/node-native    N-API bridge and platform-package definition
core/mobile-ffi     C/JNI bridge for native mobile integrations
sdk/node            Node.js agent SDK
sdk/python          Python agent SDK
integrations/mcp    Portable MCP server
integrations/agent-plugin  Vendor-neutral Agent Plugin bundle
integrations/openclaw      Native OpenClaw channel
integrations/hermes        Native Hermes platform plugin
docs                Protocol, security and compatibility documents
```

The hosted aTalk service, backend and product applications are not part of this repository. Their public security boundaries and interoperable behavior are nevertheless documented here so SDK and integration developers can reason about the complete message path.

The architecture is intentionally split across trust boundaries: plaintext and private keys remain on peers, while the hosted service resolves identities, evaluates policy and temporarily relays ciphertext. See [docs/architecture.md](docs/architecture.md) for the complete runtime view and deferred transport work.

## Development

Requirements: Node.js 20.17+, pnpm 11, Rust stable and Python 3.11+.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm audit:sdk
pnpm smoke:sdk:node

python -m venv sdk/python/.venv
sdk/python/.venv/bin/python -m pip install -e 'sdk/python[test]'
sdk/python/.venv/bin/python -m pytest sdk/python/tests
```

Rust, TypeScript and Python reproduce the same checked-in protocol vector. The Node smoke test packs the actual npm tarballs, installs them into an empty consumer and loads the Rust binary through `@atalk/sdk`.

## Security and compatibility

Read the [security model](docs/security.md) to understand current guarantees and explicit production gaps. Use [SECURITY.md](SECURITY.md) to report a vulnerability privately. Protocol and SDK versioning are documented in [docs/sdk-versioning.md](docs/sdk-versioning.md). The architectural decisions behind the public surface are available in [docs/adr](docs/adr).

Copyright 2026 Ariel Garbini. Licensed under Apache-2.0.
