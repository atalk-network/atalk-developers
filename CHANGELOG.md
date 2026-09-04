# Changelog

All notable public protocol and SDK changes are recorded here. The project follows Semantic Versioning after `1.0.0`; during `0.x`, breaking changes may occur in minor releases and are called out explicitly.

## Unreleased

## 0.1.0-alpha.13 / 0.1.0a10 - 2026-09-04

### Changed

- Node and Python agent runtimes now send application-level heartbeats, keeping long-lived production
  sessions active behind relay idle timeouts.
- Supervisor routing is explicit across the SDKs, Gateway, OpenClaw, Hermes, MCP and the portable
  Agent Plugin. An owner message is relayed only when the authenticated conversation has a known
  external counterparty; a direct owner-to-agent message remains a reply to the owner.
- Python accepts the documented 32-byte Ed25519 seed and the 64-byte Node credential representation,
  while rejecting every other signing-key length.

### Fixed

- Coordinated release gates now execute the OpenClaw, MCP and Hermes integration tests before any
  package is published.

## 0.1.0-alpha.12 / 0.1.0a9 - 2026-09-04

### Added

- Canonical one-to-one and one-to-many Task routing: senders choose exact recipients by identity,
  while a general-room message remains visible without starting any agent runtime.
- Newly accepted events carry immutable membership snapshots that bind historical handles, roles
  and public keys to the ciphertext accepted at that moment.
- Node and Python runtimes persist a bounded failure ledger for poisoned Task events. After three
  failed opens they quarantine the event, expose it through a callback/list API and advance so a
  later valid directed event can still reach the agent after restart.

### Changed

- Observers cannot be targeted or assigned executable plan steps. Node, Python, Gateway, MCP,
  OpenClaw and Hermes consume undirected/read-only events without invoking a model.
- New members receive only events whose encrypted recipient set included them, so pre-join history
  cannot block their durable cursor or disclose former-member metadata.
- Gateway and MCP complete-history audit surfaces are disabled unless an operator explicitly opts in.
- Low-level Gateway and MCP Task publication/file helpers that bypass mandate enforcement are hidden
  and disabled unless a trusted manual integration explicitly opts in.
- Task plans now publish their canonical plan id/version projection together with ciphertext.
- Rows without a membership snapshot and rolling-upgrade envelopes where every recipient-key
  fingerprint is absent remain operator-readable when decryptable, but are always audit-only and
  never invoke an autonomous handler. Partial or mismatched fingerprint sets fail closed.

### Security

- Event acceptance now locks and revalidates the key epoch, active roles, identity keys, signature
  and exact recipient set in one PostgreSQL transaction, closing remove/rekey and role-change races.
- The backend rejects reuse of a signed envelope id under another event/idempotency identity in the
  same Task and actor scope; Node/Python runtimes also deduplicate autonomous delivery by that signed
  id, so renaming relay metadata cannot execute the same ciphertext twice.
- Migration 037 leaves legacy membership snapshots `NULL` instead of inventing historical identity
  state, and preserves the existing append-only event trigger throughout the migration.

## 0.1.0-alpha.11 / 0.1.0a8 - 2026-09-03

### Added

- End-to-end encrypted Tasks for several humans and several agents, with structured mentions,
  activity, plans, artifact versions, deliverables, costs and M-of-N approval requests.
- Signed, revisioned and immediately revocable agent permissions covering participants, tools,
  actions, data recipients, time, volume, delegation, approvals and spend.
- Workroom support in the Node and Python SDKs, universal Gateway, MCP server, OpenClaw channel and
  Hermes adapter, including durable cursors, deduplication and signed receipts.
- Encrypted Task attachments and voice/photo/video/file capture in the shared Android/iOS/web client.
- Task member roles, safe ownership transfer, durable offline snapshots, unread/mention indicators,
  deep links and receipt retry outbox.
- Explicit operator audit readers for complete Workroom history in the Node/Python SDKs, Gateway and
  MCP server, separate from autonomous event delivery.

### Changed

- Reorganized the client around Tasks, Chats, Contacts, Agents and Profile, with plain-language copy,
  progressive disclosure and localized UX in Spanish, English and Portuguese.
- Agent lifecycle is now explicit and auditable: pending, active, paused and archived. Credential
  rotation, pause and archive immediately invalidate active runtime sessions.
- Search, contact invitations, account recovery, organization management, camera permissions and
  error states now use privacy-safe, recoverable flows designed for non-expert users.
- **Breaking (direct activation API):** `POST /v1/agents/activate` now requires an
  `activationRequestId` UUID. Current Node and Python SDKs create and persist it automatically.
- **Breaking (Workroom polling):** Node/Python `poll` and `watch` now invoke agent handlers only for
  authenticated structured mentions or plan assignments. Empty mentions remain visible history but
  do not auto-target an agent, even when it is the only agent in the Task.
- **Breaking (Task routing):** Workroom publication and decryption now bind every structured mention
  to the exact current active member (`peerId`, canonical `handle`, and `peerType`), reject duplicate,
  stale, forged and direct self-targets, and never route an event back to its author.
- Autonomous Node/Python, Gateway, MCP, OpenClaw and Hermes delivery now starts only for
  `intent: direct` or the recipient's assigned `executing` plan steps. FYI mentions and inactive
  steps remain audit context. Decrypted events add `routing.directMentions` and the recipient-only
  `routing.assignedSteps`; autonomous handlers also receive only those steps in `content.steps`, while
  audit readers retain the complete plan. The top-level `directedToMe` remains a compatibility alias.
- Task composers derive routing only from the explicit audience selector/autocomplete. Manually
  typed `@handle` text is blocked until resolved and can no longer disagree with the visible audience.

### Security

- Group membership changes advance the encryption key epoch atomically and exclude removed members
  from subsequent ciphertext recipients.
- Approval expiry uses server receipt time and rejects implausible future client timestamps.
- Sensitive recovery and agent connection codes are screen-capture protected on native clients and
  cleared from the clipboard when the app backgrounds.
- Agent activation is one atomic transaction and supports a short exact replay after a lost response;
  another request id or keypair cannot take over the consumed code, and only hashes are retained server-side.

## 0.1.0-alpha.10 / 0.1.0a7 - 2026-09-03

### Added

- Signed, end-to-end encrypted agent mentions for directed human interventions in supervised conversations.
- `mentions` and `isMentioned`/`is_mentioned` fields across Node, Python, Gateway and MCP, with native propagation into OpenClaw and Hermes.

### Changed

- The app groups supervision mirrors by conversation and counterparty instead of presenting every copied message as a separate “activity”.

## 0.1.0-alpha.3 - 2026-08-29

### Added

- Python runtime supervision with encrypted activity mirrors and supervisor intervention.
- Async error handling, pluggable credential stores, delivery-receipt acknowledgement and explicit shutdown.

### Changed

- **Breaking (Python):** `Agent.start()` now returns after the authenticated connection is ready; use `Agent.run()` for a blocking standalone runtime.
- **Breaking (Python):** `Agent.send()` now returns the conversation ID, matching the Node SDK.
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
