# Workrooms, tasks and granular mandates

This document describes the domain core, authenticated HTTP adapter, mobile/web product surface and
agent integration boundary. Product surfaces call a workroom a **Task**; `workroom` remains the
stable internal/protocol name.

## Product model

A **workroom** is one supervised unit of work. It can contain several people and agents rather than a
single pairwise conversation.

### Explicit agent routing

Every participant receives and may audit Task ciphertext, but visibility is not an instruction. An
autonomous agent handler runs only when the decrypted, authenticated payload contains a structured
mention matching that agent's exact peer id with `intent: "direct"`, or when a plan step explicitly
assigns that peer id and is currently `executing`.
An empty/missing mention list is a general room message and triggers no agent, including in a Task
that currently has only one agent. Text that happens to contain `@handle` has no routing authority.

Both publication and decryption bind each mention's peer id, canonical handle and peer type to the
current active membership. Duplicate/stale/forged targets and a direct self-mention are rejected.
Events authored by the runtime never route back to that runtime. FYI mentions and
`waiting_approval`/`blocked`/`completed`/`cancelled`/`expired` steps stay in audit history without
starting work. Decrypted SDK events expose `routing.directMentions` and only the recipient's
`routing.assignedSteps`. Autonomous `poll`/`watch` handlers receive a plan payload whose `steps` are
also reduced to that recipient-only executable list; the full plan exists only on the explicit audit
surface.

Node and Python `poll`/`watch` enforce this rule before invoking a handler while still advancing the
durable automation cursor over verified undirected traffic. Their explicit `readAuditEvents` /
`read_audit_events` surfaces expose the complete history without moving that cursor. Gateway and MCP
mirror this split with a directed default and an explicitly named audit surface. This changes the
consumer behavior of early alpha SDKs but does not change protocol-v1 bytes: structured encrypted
`mentions` already existed, and old payloads without them remain readable as non-triggering history.
The stricter canonical-member validation is fail-closed: an older event whose structured target is no
longer an active member is not eligible for rendering or autonomous delivery.

1. A human creates a workroom with an encrypted objective and optional visible deadline.
2. Owners or supervisors add identities they control directly. An external person accepts a signed,
   role-specific invitation before a manager grants encrypted access; an external agent requires an
   active bilateral agent authorization.
3. Contributors publish encrypted messages, structured activity, plans, artifact versions, costs and
   approval requests in threads. `@mentions` are explicit typed fields inside the ciphertext.
4. An agent acts under a signed mandate. Its runtime/gateway checks every proposed use against the
   decrypted terms before invoking a tool or sending data.
5. A threshold can move work to `waiting_approval`; eligible humans sign approve/reject decisions.
6. Any authorized manager can intervene. The principal or issuer can revoke the mandate immediately.
7. Deliverables and their versions remain attached to an ordered, signed timeline.

## State and roles

Valid workroom states:

```text
executing ───────> waiting_approval ───────> executing
    │                     │                      │
    ├───────────> blocked ┴──────────────────────┤
    │                 │                          │
    ├───────────> completed                      │
    ├───────────> cancelled <────────────────────┘
    └───────────> expired (automatic at the server deadline)
```

`completed`, `cancelled` and `expired` are terminal. The deadline must be in the future according to
the server clock. Once reached, the server rejects every content, membership, approval, receipt and
mandate mutation independently of whether a background expiry worker has run; reads remain available
and the status is reconciled atomically to `expired`. Owners and supervisors manage membership and state;
contributors append work; observers are read-only. The initial owner must be an active human.

## What the relay sees

| Relay-visible metadata | Always encrypted |
| --- | --- |
| Workroom/thread/event ids | Objective and thread titles |
| Member peer ids, peer kind and roles | Message and activity body |
| Lifecycle state and deadline | `@mention` targets and intent |
| Event kind, key epoch, time and ciphertext hash | Plan contents and assignments |
| Artifact/version/attachment routing ids | Artifact name, description and bytes |
| Approval eligibility, threshold and decision | Approval rationale |
| Mandate parties, revision and validity | Purpose, grants, limits and end conditions |
| Signed commitments, revocations and receipts | Monetary/token values and usage details |

Visibility here is intentionally minimal, not zero. Membership, timestamps and event types are traffic
metadata. Product copy and privacy documentation must not imply that E2EE hides this metadata.

## E2EE envelopes

`WorkroomEncryptedEnvelope` currently defines two wire variants:

- `ATALK_GROUP_BOX_V1`: one content ciphertext and one wrapped content key per recipient.
- `MLS_1_0`: a reserved interoperable envelope for the future reviewed group-session implementation.

The sender signs the complete envelope and its ciphertext hash. The service verifies sender,
workroom, hash and signature but never decrypts. Membership changes require a replacement descriptor
at the next key epoch with fresh wraps for exactly the post-change members. Membership, descriptor and
persisted `currentKeyEpoch` are committed in one transaction; a stale compare-and-swap fails. This
means a newly added participant can read the objective immediately and a removed participant is not
included in the next descriptor key. The current epoch is enforced on new thread headers and events.
Attachments remain independently encrypted and are referenced by artifact versions.

External-human membership is deliberately two-phase. The manager creates a `PENDING` invitation
without changing the member set. The invited identity signs the exact workroom, membership id, role,
sender and validity window, producing `ACCEPTED`. The inviting manager then reloads the current key
epoch and finalizes with a fresh descriptor rekey. Concurrent accepted invitations therefore cannot
reuse an epoch: one finalizes, and the other remains accepted and retryable after refresh. Bilateral
blocks and account-deletion eligibility are checked again at acceptance and finalization. Discovery
settings never count as consent.

Approval projections expose request/event ids, encrypted-envelope hash, eligible peer ids, M-of-N
threshold, expiry and signed decisions. They never expose plaintext rationale. Pending approvals are
available in task detail and through `GET /v1/workrooms/:id/approvals`; an approval request pauses an
executing task and a completed threshold resumes it. Rejected/impossible thresholds block it.

## Mandate lifecycle

The client creates three related objects:

1. `SignedMandate`: complete readable terms, signed by `issuedByPeerId`.
2. `MandateEncryptedTermsEnvelope`: the signed terms encrypted for principal, actor and any authorized
   supervisor.
3. `SignedMandateCommitment`: minimal metadata plus the hash of both objects.

The service verifies all signatures and bindings, then discards the plaintext copy. SQL persists only
the encrypted envelope, signed commitment and key snapshot. Revision `n + 1` must include revision
`n`'s terms hash. A signed revocation applies to the mandate series.

The pure `evaluateMandateUse` function is designed for SDKs/gateways. It checks:

- actor/delegate and maximum delegation depth;
- participant allowlist;
- action and tool/action grants;
- resource permissions and explicit recipients for actions that export data outside the Task;
- per-period spend ceilings and volume counters;
- time validity and reported end conditions;
- matching approval thresholds with already verified approval evidence.

The evaluator never treats unverified approver ids as proof. The gateway must verify signed decisions,
eligibility and current revocation/revision state first.

Task content itself is group content in protocol v1: every active member receives a wrapped copy of
the content key and can decrypt messages and files published to that Task. A mandate may restrict an
agent from reading, creating or exporting files, but it does not create a private file subset inside
the same Task. Use a separate Task for a smaller audience until recipient-scoped artifact threads are
introduced.

## Idempotency and audit

Every mutation has an actor-scoped idempotency key. Reusing a key with the same payload returns the
existing record; reusing it for different content fails. SQL serializes mandate revisions and receipt
appends with transaction advisory locks.

Receipts form one hash chain per workroom. Each includes its own signing-public-key snapshot, payload
hash, previous receipt hash, outcome and timestamp. Append-only database triggers reject updates or
deletes to events, versions, decisions, mandates, revocations and receipts.

Signed receipts establish integrity and attribution of recorded actions. They do not prove that an
unmediated third-party runtime reported every off-platform action. In protocol v1, receipt submission
is a separately signed, retryable attestation by the actor; it is not transactionally coupled to the
mutation it references. Product UI therefore labels an unsent receipt as a pending security record,
not as a failed task action. A regulated-grade audit mode must either atomically bind mutation and
receipt or have the service validate the referenced immutable record and its canonical payload hash.

## Implementation map

- Protocol schemas, group encryption, signatures and pure permission evaluation:
  [`core/protocol/src`](../core/protocol/src).
- Node runtime client, durable automation cursor and permission-aware effects:
  [`sdk/node/src/workrooms.ts`](../sdk/node/src/workrooms.ts).
- Python-compatible implementation: [`sdk/python/src/atalk/workrooms.py`](../sdk/python/src/atalk/workrooms.py).
- Runtime integrations: [Gateway](../integrations/gateway), [MCP](../integrations/mcp),
  [OpenClaw](../integrations/openclaw) and [Hermes](../integrations/hermes).

The hosted `/v1/workrooms` service and Android/iOS/web product implementations are outside the
public developer repository. Their interoperable envelope, routing, privacy and permission
boundaries are documented here and in the public SDK tests; the server's private storage
implementation is not presented as a public source path.

Production still requires operational gates rather than missing product flows: apply every migration,
mirror per-process rate limits at the shared edge when running multiple replicas, monitor the approval
expiry worker, operationalize the published retention and cryptographic-erasure controls, and complete an end-to-end smoke test
with two humans and two independent agent runtimes.
