# Device sessions

## Authentication and key recovery

Every successful human sign-in on an already trusted installation creates an opaque, independently revocable session. The server stores
only a hash of the bearer token together with a public session identifier, device label, platform,
application version, creation time, last activity and expiry. Tokens are never returned by the
management API.

An email OTP proves access to the account, but it never replaces or discloses an existing identity's
private keys. A new installation creates a short-lived linking request and displays a six-digit
comparison code. An already trusted installation must show the same code and approve the request.
It encrypts the available identity-key bundles directly to the new installation's ephemeral X25519
public key. The backend stores and forwards that signed ciphertext but cannot decrypt it. Only after
the new installation decrypts and validates the bundle can it consume the request and receive a session.

An existing account can also recover without the old device. A WebAuthn passkey first authenticates
the account. When that authenticator supports the PRF extension, its deterministic secret unwraps the
locally generated recovery key and restores the encrypted identity vault. Other authenticators still
require the `ATLK1-…` recovery code after authentication. The backend stores passkey public data and
encrypted wrappers; it never receives biometric data, a passkey private key, the recovery key/code or
decrypted identity keys.

## Session management

The profile lists active sessions for the complete human account: the personal identity and any
corporate personas owned by that account. Agent runtime sessions are deliberately excluded and remain
under the corresponding agent's administration screen.

A person can rename a device, revoke one remote session, or revoke the complete account. Revocation
invalidates HTTP authentication, disables push registrations bound to that session and closes only the
WebSocket connections authenticated by that session. Other devices remain connected when one session
is revoked.

Each installation also keeps a local message-sync cursor. The backend journal contains the original
signed encrypted envelope for both the sender and recipient, so incoming messages and sent copies
converge on phone and web after either device was offline. The default journal retention is 30 days;
the local encrypted database remains the durable user copy.

Tasks use their own paginated signed/ciphertext history and encrypted descriptor. Once a linked or
recovered installation has the identity keys, it can authenticate the current Task descriptor and
decrypt the workroom history available to that identity. Mobile and web cache that material encrypted
at rest and keep independent cursors; the service never needs the Task objective, message body, plan,
file descriptor or mention targets in plaintext.

Identity switching rotates the current token. The replacement session keeps the same device metadata,
but is bound to the newly selected peer so cryptographic keys, conversations and queues remain isolated.

Version 1 shares an identity key bundle among explicitly trusted installations. Revoking a session
stops future API, WebSocket and sync access, but cannot erase content or key material already obtained
by that installation. Per-device message keys and key transparency remain a later protocol upgrade.
