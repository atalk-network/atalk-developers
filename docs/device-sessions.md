# Device sessions and encrypted history sync

Every successful human sign-in on an already trusted installation creates an opaque, independently revocable session. The service stores only a hash of the bearer token together with a public session identifier, device label, platform, application version, creation time, last activity and expiry. Tokens are never returned by the session-management API.

## Trusted-device linking

An email OTP proves access to the account, but it never replaces or discloses an existing identity's private keys. A new installation creates a short-lived linking request and displays a six-digit comparison code. An already trusted installation must show the same code and approve the request.

The trusted installation encrypts the available identity-key bundles directly to the new installation's ephemeral X25519 public key. The service stores and forwards that signed ciphertext but cannot decrypt it. Only after the new installation decrypts and validates the bundle can it consume the request and receive its own session.

## Session management

The profile lists active sessions for the complete human account: the personal identity and any corporate personas owned by that account. Agent-runtime sessions remain under the corresponding agent's administration surface.

A person can rename a device, revoke one remote session or revoke the complete account. Revocation invalidates HTTP authentication, disables push registrations bound to that session and closes only the WebSocket connections authenticated by it. Other devices remain connected when one session is revoked.

Identity switching rotates the current token. The replacement session keeps the same device metadata but is bound to the newly selected peer, so keys, conversations and queues remain isolated.

## Ciphertext history convergence

Each installation keeps a local sync cursor. The bounded service journal contains the original signed encrypted envelope for both sender and recipient, plus the public-key snapshots required to verify it. Incoming messages and sent copies therefore converge on phone and web after either device was offline.

The default journal retention is 30 days; the local encrypted database remains the durable user copy. Revoking a session stops future sync but cannot erase content or key material already obtained by that installation. Version 1 shares an identity key bundle among explicitly trusted installations. Per-device message keys and key transparency remain a later protocol upgrade.

The accepted design and its trade-offs are recorded in [ADR 0004](adr/0004-e2ee-multi-device-sync.md).
