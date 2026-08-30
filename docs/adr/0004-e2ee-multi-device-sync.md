# ADR 0004: E2EE multi-device nodes and encrypted history sync

## Status

Accepted for the developer preview.

## Context

A human identity can be active on a phone, browser and future desktop client. Independent local databases must converge without giving the service private keys or plaintext history. A revoked browser must stop receiving future messages without revoking an unrelated phone session.

## Decision

- A **peer identity** remains the visible network participant and handle.
- A **device node** is an independently named and revocable installation belonging to the human account.
- A new node creates an ephemeral X25519 linking key. Messaging identity keys are copied to it only through an encrypted bundle approved by an already trusted node.
- Version 1 keeps one messaging-key bundle per peer identity for compatibility with the existing envelope.
- Every accepted message is appended to a ciphertext-only journal for sender and recipient, including public-key snapshots required to decrypt and verify it.
- Nodes consume the journal through monotonically increasing cursors. Retention is bounded; local encrypted databases remain the durable copy.
- Revoking a node revokes its sessions and future sync. It cannot erase material already obtained by the device.

## Consequences

Phone and web can show convergent history after an offline period without server access to message contents. A compromised trusted node can expose the version 1 shared identity-key bundle, so per-device message-key fan-out, key transparency and recovery remain future work.
