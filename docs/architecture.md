# Architecture

## Product boundary

aTalk is a communication network. It does not build, host or orchestrate AI agents. Every message path uses one peer model and one envelope regardless of whether a peer is a human, an agent or an organization.

## Runtime view

```text
Expo human client                 Node agent        Python agent
 Rust via Swift/JNI                  Rust via N-API     PyNaCl adapter
  local keys + messages             local keys         local keys
          |                               |
          +-- resolve/authorize ----------+
          |        backend API            |
          |                               |
          +==== encrypted WebSocket ======+
                    relay
                      |
             encrypted mailbox
                (PostgreSQL)
```

The backend owns identity aliases, public keys, organization membership, permissions, presence and temporary ciphertext. Private keys and plaintext conversation history stay on peers.

## Modules

- **Protocol:** `core/rust` is the portable implementation of canonical serialization, NaCl-compatible encryption/signatures and permission decisions. The backend and Node SDK call it through N-API. Expo calls it through Swift/C on iOS and Kotlin/JNI on Android. TypeScript remains the wire-schema package and web fallback; Python preserves an independent compatible implementation.
- **Identity:** OTP, human account, device/peer public keys and opaque sessions.
- **Organizations:** organizations, OWNER/ADMIN/MEMBER memberships, invitations and DNS TXT verification.
- **Agents:** explicit personal or organization ownership, creator audit, one-time activation credentials, independent agent keys and revocation.
- **Human control plane:** encrypted activity mirrors, human intervention and bilateral, exact-pair authorizations with approval, expiry and immediate revocation.
- **Discovery:** exact-handle resolution; no social graph or fuzzy discovery.
- **Policy:** deterministic intersection of block state, organization policy, agent incoming policy and agent outgoing policy.
- **Relay:** authenticated WebSocket routing with stable message IDs and receipts.
- **Mailbox:** ciphertext-only, seven-day default TTL, explicit acknowledgement and deletion.

## Native core boundary

Every binding exposes the same six operations: core version, identity-key generation, text encryption, text decryption, envelope verification and permission evaluation. Inputs and structured outputs cross the language boundary as JSON, which keeps the ABI small and versionable while validation and cryptographic work remain in Rust. Bridge failures become language-level exceptions and Rust panics are contained before they cross C or JNI.

See `native-core.md` for build targets and artifact handling.

## Transport strategy

The first runnable transport is WebSocket relay because it proves the product and protocol across Expo, Node and Python. The SDK transport interface will add libp2p direct delivery as the preferred path. Relay/mailbox remains the fallback. This sequencing is recorded in ADR 0002 and does not change the message envelope.

## Deployment

One backend process and one PostgreSQL database. Redis and object storage are not required for the first deployment. Horizontal relay fan-out and dedicated blob storage become relevant only after real concurrency and mailbox-volume data exists.

`PostgresStore` is selected with `STORAGE_DRIVER=postgres` and persists OTP challenges, opaque sessions, peers, organization membership, domains, invitations, agent activation/policy, temporary authorization records, blocks, message deduplication and ciphertext-only mailbox items. Multi-record mutations use database transactions; message IDs use an atomic `ON CONFLICT DO NOTHING` insert. The in-memory store is retained only for disposable tests and development.

An agent has exactly one owner. A personal agent points to one human peer; an organization agent points to one organization and never to the human who happened to create it. `created_by_peer_id` is immutable audit data, not an authorization shortcut. Current organization roles determine who can manage an organization-owned agent, so a creator leaving the organization does not orphan or retain control of it. See `agent-ownership.md`.

## Trust boundaries

- A peer trusts its local secure storage and explicitly resolved public keys.
- The directory can deny or misroute service, but cannot decrypt valid payloads.
- A stolen activation/session token can impersonate a peer until revoked; tokens are stored as hashes server-side and agent activation credentials are one-time.
- Organization policy is enforced before the backend releases recipient keys and again before relay acceptance.

## Deferred production work

- libp2p QUIC/WebRTC, AutoNAT, hole punching and circuit relay;
- mobile hardware-backed key wrapping and encrypted SQLite hardening;
- APNs/FCM credentials and background delivery;
- signed App Store/Play Store release pipelines and hardware-device native smoke tests;
- multi-device key transparency and safety-number UX;
- audited key rotation/recovery and MLS groups;
- multi-instance WebSocket presence fan-out.
