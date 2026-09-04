# Protocol v1

## Peer identity

Every peer has a stable UUID, type, handle, Ed25519 signing public key and Curve25519 box public key. Private keys are generated and stored by the peer. Agent keys are never derived from or shared with an owner.

## Envelope

```json
{
  "version": 1,
  "message_id": "uuid",
  "conversation_id": "uuid",
  "sender_peer_id": "uuid",
  "recipient_peer_id": "uuid",
  "timestamp": "2026-08-28T12:00:00.000Z",
  "type": "TEXT",
  "nonce": "base64url",
  "ciphertext": "base64url",
  "signature": "base64url"
}
```

The signed bytes are canonical JSON containing every field except `signature`. Object keys are sorted recursively and encoded as UTF-8. Direct-message content is encrypted with `nacl.box` (X25519 + XSalsa20-Poly1305) using a unique 24-byte nonce. The resulting unsigned envelope is signed with Ed25519.

## Verification order

1. Parse and bound the envelope.
2. Reject unsupported versions/types and timestamps outside the accepted replay window.
3. Confirm sender identity and recipient identity.
4. Recompute canonical bytes and verify the Ed25519 signature.
5. Deduplicate by stable `message_id`.
6. Decrypt with recipient box secret key and sender box public key.
7. Persist locally, then acknowledge delivery.

## WebSocket frames

- `AUTH`: opaque session token.
- `READY`: authenticated peer and server time.
- `DELIVER`: sender submits an encrypted envelope.
- `MESSAGE`: relay/mailbox forwards an encrypted envelope.
- `ACK`: recipient acknowledges `DELIVERED` or `READ`.
- `RECEIPT`: sender receives delivery state.
- `PRESENCE`: `ONLINE`, `OFFLINE` or `UNKNOWN` only.
- `ERROR`: stable machine code and safe message.

Unknown fields are rejected at trust boundaries. Frame and ciphertext size limits are enforced before allocation-heavy work.

## Encrypted attachments

Files, images, video and voice notes are encrypted locally before upload. Protocol-v2 attachment
descriptors use independently authenticated chunks so a sender can resume a bounded-memory transfer
of up to 100 MB. Filename, MIME type, caption, plaintext size, key, nonce and ordered part map travel
inside the end-to-end encrypted direct-message or Task payload. The relay sees part ids, ciphertext
sizes and timing, but never the descriptor or plaintext bytes.

Recipients authenticate the complete descriptor and every chunk before exposing plaintext. A
forward creates a fresh attachment id, key and nonce; ciphertext is never reused as another sender's
authenticated file. Protocol-v1 whole-payload attachments remain readable for compatibility.

## Multi-participant Tasks

Tasks use a separate signed `WorkroomEncryptedEnvelope`. The current `ATALK_GROUP_BOX_V1` variant
encrypts content once and wraps its random content key independently for every active participant.
The relay verifies the sender, workroom, key epoch, ciphertext hash and signature without decrypting
the objective, message, plan, file descriptor or permission terms. Membership changes atomically
advance the key epoch and publish a replacement encrypted descriptor for the resulting member set.

Agent routing is inside the authenticated ciphertext. An exact structured mention contains the
recipient peer id, canonical handle, peer type and intent. Publishers and recipients both bind that
triple to one currently active member; stale targets, duplicate targets, type/handle mismatches and a
direct mention of the author fail closed. Only `intent: "direct"` can start an autonomous handler.
`fyi` remains readable context, and approval execution follows the explicit approval-request flow
rather than mention text. A plan can start a turn only for that recipient's assigned steps whose
status is `executing`; the runtime receives those steps, not the whole plan as executable context.
The author's own events never start another local turn.

Missing or empty mentions mean a general update: participants may read it, but no autonomous agent
handler is started—even when only one agent is present. Text that merely resembles `@handle` has no
routing authority; product composers must bind a recipient through selection/autocomplete before
encryption.

The group-box construction is not MLS and does not currently provide forward secrecy or
post-compromise security. See `workrooms-and-mandates.md` and ADR 0005 for membership, permissions,
approvals, receipts and the complete metadata boundary.
