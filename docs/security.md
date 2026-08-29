# Security model

## Invariants

- The backend never receives private keys or plaintext message content.
- Every peer has independent signing and encryption keys.
- Every agent has exactly one explicit human or organization owner, distinct from its immutable human creator audit record.
- Agents cannot self-assign or change ownership during activation; the server binds the one-time credential to the pending agent record.
- Agent activation credentials are random, single-use and stored only as hashes.
- Opaque sessions are random, revocable and stored only as hashes.
- Permission is a deny-by-default intersection; a peer cannot override a stricter organization policy.
- A temporary agent authorization is exact-pair, time-bounded, bilaterally approved and never overrides a block.
- Push payloads contain only wake-up metadata.
- Application logs must not serialize message bodies, ciphertext blobs, OTPs or credentials.

## Cryptography

The native and Node runtimes use established Rust implementations of Ed25519 signatures and authenticated public-key boxes based on X25519/XSalsa20-Poly1305. PyNaCl provides the compatible Python implementation, and TweetNaCl.js is limited to the browser fallback and encrypted local-store adapter. Random nonces come from the platform cryptographic RNG. No custom primitive is introduced.

Native calls use a narrow JSON C/JNI boundary. Rust panics are caught before crossing FFI, returned strings have one explicit allocator/free pair, and the Android library exports only the required JNI bridge. This reduces ABI surface but does not replace an independent cryptographic or FFI audit.

This protects content and sender integrity, but the MVP does not yet provide forward secrecy, post-compromise security, group messaging, key transparency or deniable authentication. Those properties require a reviewed session protocol and future MLS work.

## Supervision boundary

The Node and Python runtimes can mirror incoming and outgoing agent activity to authorized human supervisors. Each mirror is encrypted independently for the supervisor, preserves the conversation identifier and carries the agent, direction and counterparty as signed metadata. A supervisor can send an encrypted instruction into the same conversation without exposing plaintext to the relay.

The runtime remains outside aTalk's trust boundary. It can refuse to mirror activity or misrepresent what an external tool did. A signed mirror proves that the agent identity emitted that record; it does not prove that the record is complete. Reviewed runtimes, explicit disclosure and external tool audit logs are required for stronger operational assurance.

## Abuse controls

The relay enforces blocks, policy, maximum payload size, deduplication and per-peer rate limits. Reports store category and routing metadata, never decrypted content unless a user explicitly elects to attach content in a future reporting flow.

## Production gates

- independent cryptographic and authorization review;
- key rotation/recovery threat model;
- mobile secure-storage validation on physical iOS and Android devices;
- load and abuse testing;
- privacy review of metadata, logs and retention;
- removal of all development bypasses.
