# ADR 0004: E2EE multi-device nodes and encrypted history sync

## Status

Accepted for the MVP.

## Context

A human identity such as `@ariel` can be active on a phone, a browser and a desktop at the same
time. Today those clients keep independent local databases. The relay fans live incoming messages
out to connected sockets, but the first delivery acknowledgement removes an offline mailbox item,
sent messages are not mirrored to the sender's other clients, and a fresh login can accidentally
replace the identity public keys.

The backend must not receive private keys or plaintext history. A revoked browser must stop receiving
future messages without revoking an unrelated phone session.

## Decision

- A **peer identity** remains the visible network participant and handle.
- A **device node** is an independently named and revocable installation belonging to the human
  account. A session is a temporary credential issued to one node and one active identity.
- A new node creates a separate ephemeral X25519 linking key. Messaging identity keys are copied to it only
  through an encrypted key bundle approved by an already trusted node. OTP proves account access but
  does not silently rotate or disclose identity keys.
- Version 1 keeps one messaging key bundle per peer identity for compatibility with the existing
  human, Node and Python envelope. A future envelope version can wrap a content key independently for
  every authorized device without changing the product model.
- Every accepted message is appended to a ciphertext-only sync journal for both sender and recipient.
  The journal stores the original signed envelope plus the public-key snapshots required to decrypt
  and verify it. It never stores plaintext or private keys.
- Nodes consume the journal with a monotonically increasing cursor. Incoming messages and sent-message
  copies therefore converge across devices, including after an offline period.
- Sync retention is bounded and configurable. Local encrypted databases remain the durable user copy.
- Revoking a node revokes its sessions and prevents future sync. It cannot erase plaintext a device
  already displayed; the client must lock or purge its local database on revocation.

## Linking flow

1. A new installation verifies the account email by OTP and submits only its linking public key.
2. The backend creates a short-lived pending link request and returns an opaque polling capability.
3. An existing trusted node encrypts the identity key bundle to the pending node and approves it.
4. The new node downloads and decrypts the bundle, verifies its public keys against the directory,
   consumes the request and receives its own revocable session.
5. The node downloads ciphertext journal entries after its local cursor and merges them idempotently.

## Consequences

- Phone, web and future desktop clients can show one convergent conversation history without server
  access to its contents.
- A compromised trusted node can expose the version 1 identity key bundle. Device-specific message-key
  fan-out and key transparency remain required before claiming post-compromise security.
- Browser key storage must move from raw `localStorage` values to non-exportable WebCrypto keys or an
  encrypted IndexedDB wrapper as part of the linking client work.
