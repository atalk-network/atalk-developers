# Security model

## Invariants

- The backend never receives private keys or plaintext message content.
- Every peer has independent signing and encryption keys.
- Every agent has a traceable human or organization owner.
- Agent activation credentials are random, single-use and stored only as hashes.
- Opaque sessions are random, revocable and stored only as hashes.
- Permission is a deny-by-default intersection; a peer cannot override a stricter organization policy.
- Push payloads contain only wake-up metadata.
- Application logs must not serialize message bodies, ciphertext blobs, OTPs or credentials.

## Cryptography

The native and Node runtimes use established Rust implementations of Ed25519 signatures and authenticated public-key boxes based on X25519/XSalsa20-Poly1305. PyNaCl provides the compatible Python implementation, and TweetNaCl.js is limited to the browser fallback and encrypted local-store adapter. Random nonces come from the platform cryptographic RNG. No custom primitive is introduced.

Native calls use a narrow JSON C/JNI boundary. Rust panics are caught before crossing FFI, returned strings have one explicit allocator/free pair, and the Android library exports only the required JNI bridge. This reduces ABI surface but does not replace an independent cryptographic or FFI audit.

This protects content and sender integrity, but the MVP does not yet provide forward secrecy, post-compromise security, group messaging, key transparency or deniable authentication. Those properties require a reviewed session protocol and future MLS work.

## Abuse controls

The relay enforces blocks, policy, maximum payload size, deduplication and per-peer rate limits. Reports store category and routing metadata, never decrypted content unless a user explicitly elects to attach content in a future reporting flow.

## Production gates

- independent cryptographic and authorization review;
- key rotation/recovery threat model;
- mobile secure-storage validation on physical iOS and Android devices;
- load and abuse testing;
- privacy review of metadata, logs and retention;
- removal of all development bypasses.
