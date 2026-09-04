# Security model

The SDK and connector-specific multimedia lifecycle is documented in `docs/agent-multimedia.md`. Attachment plaintext is decrypted only in the recipient process; temporary connector files use private permissions and bounded retention.

## Invariants

- The backend never receives plaintext private keys or plaintext message content.
- Every peer has independent signing and encryption keys.
- Every agent has exactly one explicit human or organization owner, distinct from its immutable human creator audit record.
- Agents cannot self-assign or change ownership during activation; the server binds the one-time credential to the pending agent record.
- Agent activation credentials are random and stored only as hashes. A consumed credential accepts
  only a short, exact idempotent replay bound to its request id and original public keys so a lost
  response cannot strand the agent or authorize a different runtime.
- Opaque sessions are random, revocable and stored only as hashes.
- Permission is a deny-by-default intersection; a peer cannot override a stricter organization policy.
- Adding an external peer to a Task requires that peer's signed consent; an owner can add identities it already controls, but cannot bypass a block, privacy rule or agent-to-agent authorization.
- Task deadlines and signed mandate validity are enforced against server time. A client clock cannot extend a permission window.
- Push payloads contain only wake-up metadata.
- Application logs must not serialize message bodies, ciphertext blobs, OTPs or credentials.

## Cryptography

The native and Node runtimes use established Rust implementations of Ed25519 signatures and authenticated public-key boxes based on X25519/XSalsa20-Poly1305. PyNaCl provides the compatible Python implementation, and TweetNaCl.js is limited to the browser fallback and encrypted local-store adapter. Random nonces come from the platform cryptographic RNG. No custom primitive is introduced.

Native calls use a narrow JSON C/JNI boundary. Rust panics are caught before crossing FFI, returned strings have one explicit allocator/free pair, and the Android library exports only the required JNI bridge. This reduces ABI surface but does not replace an independent cryptographic or FFI audit.

Direct conversations and multi-participant Tasks are supported. Task content uses a signed group envelope with one freshly wrapped content key per current recipient and an atomic rekey whenever membership changes. This prevents a removed participant from receiving later epochs, but it is not MLS: the current preview does not yet provide forward secrecy, post-compromise security, key transparency or deniable authentication. Those properties require a reviewed session protocol and future MLS work.

## Account access and encrypted recovery

OTP verifies control of the account email, but it does not disclose identity keys. Existing accounts either approve a replacement device from a trusted session or prove possession of the account recovery key. The recovery key is generated on-device and encoded as an `ATLK1-…` recovery code.

The client encrypts every locally available human identity key pair with XSalsa20-Poly1305 under that recovery key. The backend stores only the encrypted recovery vault. A registered WebAuthn passkey authenticates the account; when the authenticator supports the PRF extension, a deterministic per-credential secret wraps the recovery key so a new device can restore the vault after biometric/PIN verification. Authenticators without PRF still authenticate, then require the recovery code.

The backend stores passkey public keys, counters, transports, backup state and the wrapped recovery-key ciphertext. It never receives biometric data, the passkey private key, the recovery key, the recovery code or decrypted identity keys. Recovery and trusted-device approval both deliver the same signed, encrypted identity bundle to the replacement device.

## Abuse controls

The relay enforces blocks, communication and Task-membership policy, signed external consent, deadlines, maximum payload size, deduplication and per-peer rate limits. Reports store category, optional comment and routing/evidence identifiers, never decrypted message or attachment content.

## Production gates

- independent cryptographic and authorization review;
- independent review of passkey, device-link and encrypted-recovery flows;
- mobile secure-storage validation on physical iOS and Android devices;
- load and abuse testing;
- privacy review of metadata, logs and retention;
- removal of all development bypasses.
