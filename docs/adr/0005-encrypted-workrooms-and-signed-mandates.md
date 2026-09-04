# ADR 0005: Encrypted workrooms and signed, revocable mandates

## Status

Accepted and implemented across the authenticated service, shared Expo client, SDKs and supported
agent integrations. The product calls these workrooms **Tasks**.

## Context

Pairwise chat and temporary agent-to-agent authorization are not enough to represent a useful unit
of delegated work. A task can involve several humans and agents, multiple activity threads, a plan,
artifacts, approvals, costs and a deadline. The owner must be able to intervene or revoke authority
without giving the relay access to the work itself.

An instruction such as “research suppliers” is also too broad to be a safe authorization. Execution
needs machine-checkable limits: who may participate, which data/tools/actions are allowed, time and
spend bounds, whether delegation is possible, approval thresholds and explicit end conditions.

## Decision

### Workroom is the unit of supervised work

A workroom has multiple human/agent members with `owner`, `supervisor`, `contributor` or `observer`
roles. Its public lifecycle is one of `executing`, `waiting_approval`, `blocked`, `completed`,
`cancelled` or terminal `expired`. The server clock rejects writes at the deadline and atomically
projects an active state to `expired`, so enforcement does not depend on a client or worker. General,
activity, approval and deliverable threads share a single ordered audit
timeline. Explicit `@mentions` live inside encrypted payloads and identify their target by peer id,
handle, peer type and intent.

Plans, artifact versions, deliverables, cost entries and approval requests are immutable events. The
database holds typed routing projections so it can order and route them, but content remains in an
opaque E2EE envelope. Large artifact bytes continue through encrypted attachment storage; a workroom
artifact version references attachment ids from inside its encrypted content and in a minimal routing
projection.

### Mandates are signed capability contracts

A mandate has a stable id and monotonically increasing revision. Revision 1 has no predecessor; each
later revision commits to the preceding signed terms hash. Full terms name the principal and agent
actor, purpose, participants, data/tool/action grants, spend/volume limits, validity, delegation,
approval thresholds and end conditions.

The issuer signs the full terms, encrypts that signed document for authorized recipients and signs a
minimal commitment containing identity, validity and hashes. The relay stores only the encrypted
terms and commitment. A trusted runtime or gateway decrypts and deterministically evaluates a
proposed action. The relay can still enforce membership, active/revoked state, validity and revision
without learning purpose, tools, data or budget.

Revocation is a separately signed, append-only object. Principal, issuer or an authorized workroom
manager may revoke. A new revision narrows or changes authority; it never mutates older evidence.

### Receipts are append-only evidence, not a completeness claim

Every material state change can produce a signed receipt containing a payload hash and the previous
receipt hash. Storage serializes appends per workroom and rejects forks. The signing public key is
captured in the signed receipt so verification remains possible after key rotation or account erasure.

Receipts prove that a particular participant signed the recorded event and that the stored sequence
has not been rearranged. They do **not** prove that an external runtime disclosed every action it took.
The v1 receipt endpoint is also separate from the underlying mutation, so the receipt is the actor's
signed attestation rather than server-issued proof that the referenced mutation committed atomically.
Tool adapters and gateways must emit receipts at their enforcement boundary to increase coverage.

### E2EE evolution

Protocol v1 supports `ATALK_GROUP_BOX_V1`, where an encrypted content key is wrapped for every current
member, and reserves `MLS_1_0` as the forward-compatible group envelope. Membership changes advance a
persisted key epoch atomically with a replacement encrypted descriptor whose recipients are exactly
the post-change member set. New members never enter without the next objective key and removed members
never receive it. New thread headers/events must match the current epoch. This design does not claim
post-compromise security until the MLS/session layer is implemented and independently reviewed.

External people cannot be added merely because they are discoverable. They first sign an exact,
expiring membership invitation; acceptance persists consent but does not change the E2EE member set.
The inviting manager finalizes with a fresh compare-and-swap rekey. If two accepted invitations race,
the loser stays accepted and can be finalized after refreshing the epoch. External agents instead
require the existing owner-approved bilateral agent authorization. Any bilateral block prevails at
creation, acceptance and finalization.

Approval requests have plaintext-free server projections containing only routing/threshold metadata,
the request ciphertext hash and signed decisions. They are returned as pending/resolved views so a
client can verify M-of-N evidence after reload. Creating a request moves active work to
`waiting_approval`; satisfying the threshold resumes execution, while an impossible threshold blocks
the workroom.

### Erasure and audit identity

Workroom rows retain peer UUID snapshots rather than foreign keys. This lets account deletion remove
an agent record while leaving signed, ciphertext-only audit evidence intact. Public signing-key
snapshots remain with signed evidence. Product policy must define retention and cryptographic erasure
before routes are exposed.

## Consequences

- Human supervision becomes a first-class state machine rather than a special chat view.
- One mandate format can be enforced consistently by aTalk gateways, SDKs and external agent plugins.
- The server can route work and enforce coarse authorization without reading objectives, messages,
  mentions, plans, artifacts, costs, rationales or detailed mandate terms.
- Idempotency keys are mandatory on every write boundary; immutable events and signed receipts make
  retries safe and tampering detectable.
- Group key distribution, membership rekey, approval notifications and durable client/runtime receipt
  submission are implemented. Shared-edge rate limiting, retention/cryptographic-erasure operations,
  monitoring and independent cryptographic review remain explicit production gates.

## Rejected alternatives

- **Plaintext task records on the server:** simpler search and reporting, but contradicts the E2EE
  product boundary.
- **One mutable JSON task document:** easy initially, but loses independent authorship, conflict-safe
  sync, artifact history and auditable approval transitions.
- **OAuth scopes alone:** useful for service access, but cannot express purpose, participants,
  delegation, cumulative limits or end conditions for an autonomous agent.
- **A receipt log presented as complete observability:** misleading unless every tool execution path is
  mediated by a trusted enforcement point.
