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
- A batch authorization is only a convenience for creating independent exact-pair grants; it never creates one shared or transitive capability.
- Human, agent and organization identities are not publicly discoverable by default. Search visibility never grants messaging permission.
- Push payloads contain only wake-up metadata.
- Application logs must not serialize message bodies, ciphertext blobs, OTPs or credentials.

## Cryptography

The native and Node runtimes use established Rust implementations of Ed25519 signatures and authenticated public-key boxes based on X25519/XSalsa20-Poly1305. PyNaCl provides the compatible Python implementation, and TweetNaCl.js is limited to the browser fallback and encrypted local-store adapter. Random nonces come from the platform cryptographic RNG. No custom primitive is introduced.

Native calls use a narrow JSON C/JNI boundary. Rust panics are caught before crossing FFI, returned strings have one explicit allocator/free pair, and the Android library exports only the required JNI bridge. This reduces ABI surface but does not replace an independent cryptographic or FFI audit.

This protects content and sender integrity, but the MVP does not yet provide forward secrecy, post-compromise security, group messaging, key transparency or deniable authentication. Those properties require a reviewed session protocol and future MLS work.

## Encrypted attachments

Files, images and videos are encrypted and authenticated locally before upload. The service stores opaque parts and observes their ciphertext sizes, upload/access timing, the uploading session and retention expiry. It does not receive the plaintext filename, MIME type, caption, content key, nonce or ordered part map because those values travel inside the end-to-end encrypted message descriptor.

SDKs reject plaintext over 100 MB, parts over 8 MB, missing/reordered parts and ciphertext that fails authenticated decryption. Opaque parts expire after 30 days by default and are additionally constrained by a rolling storage quota. Temporary server storage is not the user's durable backup.

## Multi-device boundary

An OTP verifies control of the account email but does not disclose an existing identity's private keys. A new installation can be approved by an already trusted device: it creates an ephemeral X25519 linking key, and the trusted device encrypts the identity-key bundle directly to that key. The service stores and forwards only signed ciphertext plus a hash of the short-lived claim capability.

Each installation receives an independently revocable opaque session and consumes a bounded ciphertext-only history journal. Revoking a device prevents future API, WebSocket, push and sync access. It cannot erase keys or plaintext that the device already obtained. Version 1 therefore does not claim post-compromise security; per-device message keys and key transparency remain production work.

## Account access and encrypted recovery

The account recovery key is generated on-device and encoded as an `ATLK1-…` recovery code. The client encrypts every locally available human identity key pair with XSalsa20-Poly1305 under that key, and the backend stores only the encrypted recovery vault.

A registered WebAuthn passkey authenticates the account. When the authenticator supports the PRF extension, a deterministic per-credential secret wraps the recovery key so a replacement device can restore the vault after biometric or PIN verification. Authenticators without PRF still authenticate the user and then require the recovery code.

The backend stores passkey public keys, counters, transports, backup state and wrapped recovery-key ciphertext. It never receives biometric data, passkey private keys, the recovery key, the recovery code or decrypted identity keys. Passkey recovery and trusted-device approval both deliver the same signed, encrypted identity bundle to the replacement device.

## Discovery and metadata privacy

Public discovery is opt-in. Organization-internal discovery defaults to enabled and can be disabled by the identity or its authorized manager. The service filters results before returning them and hides either side of a block. Contacts and explicitly owned personal agents remain discoverable only to their authorized owner.

The service still observes account and peer identifiers, public keys, policy and organization relationships, routing metadata, ciphertext size/timing, delivery state, device/session metadata and abuse-control events. E2EE protects content, not this operational metadata.

## Supervision boundary

The Node and Python runtimes can mirror incoming and outgoing agent activity to authorized human supervisors. Each mirror is encrypted independently for the supervisor, preserves the conversation identifier and carries the agent, direction and counterparty as signed metadata. A supervisor can send an encrypted instruction into the same conversation without exposing plaintext to the relay.

The runtime remains outside aTalk's trust boundary. It can refuse to mirror activity or misrepresent what an external tool did. A signed mirror proves that the agent identity emitted that record; it does not prove that the record is complete. Reviewed runtimes, explicit disclosure and external tool audit logs are required for stronger operational assurance.

## Abuse controls

The relay enforces blocks, policy, maximum payload size, deduplication and per-peer rate limits. Reports store category and routing metadata, never decrypted content unless a user explicitly elects to attach content in a future reporting flow.

Blocked peers disappear from discovery and cannot resolve keys or deliver new envelopes. Push delivery is best effort and cannot remove or acknowledge an encrypted mailbox item. Providers receive only a generic message or authorization wake-up, never sender identity, handles, purpose or ciphertext.

## Production gates

- independent cryptographic and authorization review;
- independent review of passkey, device-link and encrypted-recovery flows;
- mobile secure-storage validation on physical iOS and Android devices;
- per-device message keys, key transparency and safety-number UX;
- attachment retention/quota abuse testing and external-storage migration review;
- load and abuse testing;
- privacy review of metadata, logs and retention;
- removal of all development bypasses.
