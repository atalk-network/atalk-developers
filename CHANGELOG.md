# Changelog

All notable public protocol and SDK changes are recorded here. The project follows Semantic Versioning after `1.0.0`; during `0.x`, breaking changes may occur in minor releases and are called out explicitly.

## 0.1.0-alpha.6 - 2026-08-30

### Fixed

- Declare OpenClaw `channelConfigs` metadata so setup and Control UI surfaces can discover the aTalk channel schema before loading runtime code.

## 0.1.0-alpha.5 - 2026-08-30

### Fixed

- Build the Node SDK before checking or testing framework integrations in a clean workspace.
- Normalize the MCP executable path so npm retains the `atalk-mcp` command in the published package.

## 0.1.0-alpha.4 - 2026-08-30

### Added

- Portable `@atalk/mcp-server` with receive, send, reply, read-receipt and supervised-relay tools.
- Agent Plugins 1.0 bundle shared by OpenClaw, Hermes and other compatible hosts.
- Native OpenClaw channel and native Hermes Agent platform adapters for autonomous inbound turns.
- SDK connection/identity inspection, explicit read receipts, detailed send results and continuation of known conversations.
- Tokenless restarts when a durable credential store/path already contains an activated identity.

### Changed

- Node `IncomingMessage.reply()` / `relay()` and Python `Message.reply()` / `relay()` now return the emitted message id.
- Node and Python activation tokens are optional after the first successful persisted activation.
- Node and Python package releases now coordinate framework adapters and validate their packaged public surfaces.

### Security

- Portable plugin state uses the host-managed `PLUGIN_DATA` directory and never embeds activation tokens in manifests.
- Stdio MCP logging is restricted to stderr so it cannot corrupt or leak into JSON-RPC output.

## 0.1.0-alpha.3 - 2026-08-29

### Added

- Node and Python runtime supervision with encrypted activity mirrors and supervisor intervention.
- `supervision` runtime configuration, supervisor markers on incoming messages and `relay()` for human intervention in an active agent conversation.
- A canonical agent-activity payload in `@atalk/protocol`.
- Python async error handling, pluggable credential stores, delivery-receipt acknowledgement and explicit shutdown.

### Changed

- **Breaking (Python):** `Agent.start()` now returns after the authenticated connection is ready; use `Agent.run()` for a blocking standalone runtime.
- **Breaking (Python):** `Agent.send()` now returns the conversation ID, matching the Node SDK.
- Node `Agent.start()` now resolves only after the authenticated WebSocket is ready, and revoked runtime credentials terminate the session instead of reconnecting forever.
- Python reconnects with exponential backoff and treats revoked runtime credentials as a terminal session error.

## 0.1.0-alpha.2 - 2026-08-28

### Added

- Explicit `AgentOwnership` variants for personally owned and organization-owned agents.
- A safe default policy for organization agents using `ORGANIZATION_ONLY` scopes.
- Public ownership and activation documentation.

### Changed

- **Breaking:** `PublicPeer.ownerPeerId` is now `personalOwnerPeerId`, so organization-agent creators are no longer represented as owners.
- `OWNER_ONLY` now matches only the explicit human owner of a personal agent.
- TypeScript and Rust permission evaluation use the same ownership semantics.

### Security

- Agent activation cannot self-assign or change ownership.
- Creator audit identity no longer grants implicit communication or management rights.

## 0.1.0-alpha.1 - 2026-08-28

### Added

- Canonical encrypted envelope and WebSocket frame schemas.
- Portable Rust core with TypeScript/Python golden-vector compatibility.
- Prebuilt N-API distribution design for macOS, Linux and Windows.
- Node.js agent activation, encrypted messaging, reconnect and receipt handling.
- Python agent activation and encrypted messaging.
- Public package metadata, installation guides and release workflows.

### Security

- Local generation and storage of agent identity keys.
- Signed, end-to-end encrypted 1:1 message envelopes.
- Private vulnerability reporting policy.

This release is a developer preview and does not carry API stability guarantees.
