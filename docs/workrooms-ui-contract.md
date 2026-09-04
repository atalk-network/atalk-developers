# Workrooms UI integration contract

This is the handoff contract for web/mobile implementation. Product copy should call this a
**Task**; `workroom` remains the stable internal/protocol name.

The hosted backend and product app sources referenced below are not shipped in the public developer
repository. Their HTTP and wire contract is published so independent clients and integrations can
interoperate with the hosted service.

## HTTP contract

Every endpoint requires the existing bearer session. All content-bearing writes accept opaque,
client-signed ciphertext only. Workroom and mandate cursors are opaque base64url strings; clients
must round-trip them unchanged.

Authenticated mutations also have independent sliding-window ceilings per actor and source IP:
create 20/60 per hour, membership 120/300 per hour, state 120/500 per hour, threads 120/500 per
hour, mandates 120/300 per hour, approvals 300/1,000 per hour, events 600/2,000 per minute and
receipts 1,200/4,000 per minute (actor/IP respectively). A `429 WORKROOM_RATE_LIMITED` includes
`Retry-After`. These process-local limits are an application guard; a multi-replica deployment must
mirror them at a shared edge or distributed limiter.

| Method and path | Request | Successful response |
| --- | --- | --- |
| `GET /v1/workrooms?status=&cursor=&limit=` | status may be repeated as a comma list; limit 1–200 | `{ workrooms: WorkroomDetail[], nextCursor: string \| null }` |
| `POST /v1/workrooms` | `CreateWorkroomInput` | `{ record, created }`, 201 on create or 200 on replay |
| `GET /v1/workrooms/:id?afterSequence=&eventLimit=` | eventLimit 1–200 | `WorkroomDetail & { events, nextAfterSequence }` |
| `GET /v1/workrooms/:id/events?afterSequence=&limit=&kind=&threadId=` | forward sequence cursor | `{ events, nextAfterSequence }` |
| `GET /v1/workrooms/:id/activity?afterSequence=&limit=&threadId=` | activity-only event view | `{ events, nextAfterSequence }` |
| `POST /v1/workrooms/:id/events` | `{ event: AppendWorkroomEvent, projection? }` | `{ record, created }` |
| `POST /v1/workrooms/:id/threads` | `WorkroomThreadRecord` | `{ record, created }` |
| `GET /v1/workrooms/:id/memberships` | none | `{ members: [{ membership, peer }] }` |
| `POST /v1/workrooms/:id/memberships` | `{ membership, membershipConsent?, expectedKeyEpoch, descriptorEnvelope, descriptorHash }` | `{ record, created, currentKeyEpoch }` |
| `GET /v1/workroom-membership-invitations` | none | `{ invitations: WorkroomMembershipInvitationView[] }`; sender/recipient only |
| `POST /v1/workrooms/:id/membership-invitations` | `{ invitationId, membership, expiresAt }` | `{ record, created }` |
| `POST /v1/workroom-membership-invitations/:invitationId/accept` | `{ signedConsent }` | `{ invitation }` |
| `POST /v1/workroom-membership-invitations/:invitationId/reject` | `{}` | `{ invitation }` |
| `POST /v1/workroom-membership-invitations/:invitationId/cancel` | `{}` | `{ invitation }` |
| `POST /v1/workroom-membership-invitations/:invitationId/finalize` | `{ expectedKeyEpoch, descriptorEnvelope, descriptorHash }` | `{ invitation, membership }` |
| `POST /v1/workrooms/:id/memberships/:peerId/remove` | `{ idempotencyKey, expectedKeyEpoch, descriptorEnvelope, descriptorHash }` | `{ removed, membership, currentKeyEpoch }` |
| `DELETE /v1/workrooms/:id/memberships/:peerId` | same safe body as POST remove; transitional alias | same as POST remove |
| `PATCH /v1/workrooms/:id/state` | `{ nextStatus, idempotencyKey }` | `{ workroom }` |
| `GET /v1/workrooms/:id/mandates?cursor=&limit=` | limit 1–200 | `{ mandates: [{ mandate, revocation? }], nextCursor }` |
| `POST /v1/workrooms/:id/mandates` | `{ signedMandate, encryptedTermsEnvelope, signedCommitment, idempotencyKey }` | `{ record, created }` |
| `GET /v1/workrooms/:id/mandates/:mandateId?revision=` | revision optional; latest by default | `{ mandate, revocation? }` |
| `POST /v1/workrooms/:id/mandates/:mandateId/revocations` | `{ signedRevocation, idempotencyKey }` | `{ record, created }` |
| `POST /v1/workrooms/:id/approvals/:requestId/decisions` | `{ signedDecision, encryptedReasonEnvelope?, idempotencyKey }` | `{ record, created }` |
| `GET /v1/workrooms/:id/approvals` | none | `{ approvals: WorkroomApprovalView[] }`; pending first |
| `GET /v1/workrooms/:id/receipts?afterSequence=&limit=` | forward sequence cursor | `{ receipts, nextAfterSequence }` |
| `POST /v1/workrooms/:id/receipts` | `{ signedReceipt }` | `{ record, created }` |

`WorkroomDetail` is exactly:

```ts
{
  workroom: WorkroomRecord & { currentKeyEpoch: number };
  membership: WorkroomMembershipRecord; // current actor
  members: Array<{ membership: WorkroomMembershipRecord; peer: PublicPeer | null }>;
  threads: WorkroomThreadRecord[];
  latestMandates: Array<{ mandate: WorkroomMandateRecord; revocation?: WorkroomMandateRevocationRecord }>;
  approvals: WorkroomApprovalView[];
  latestReceiptHash: string | null;
  latestEventSequence: number;
}
```

`peer` is null only when directory erasure happened after immutable workroom evidence was written.
The membership UUID remains available for ciphertext/audit verification.

## Shared imports

Use `@atalk/protocol` for every wire object. Do not create parallel app-only shapes.

```ts
import {
  appendWorkroomEventSchema,
  evaluateMandateUse,
  hashBase64UrlPayload,
  hashCanonical,
  mandateUseRequestSchema,
  signMandate,
  signMandateCommitment,
  signMandateEncryptedTermsEnvelope,
  signMandateRevocation,
  signWorkroomApprovalDecision,
  signWorkroomEncryptedEnvelope,
  signWorkroomReceipt,
  workroomContentPayloadSchema,
  workroomDescriptorSchema,
} from "@atalk/protocol";
```

Backend adapters instantiate `WorkroomService` from `backend/src/workrooms/service.ts`. Its public
methods are the exact non-HTTP integration boundary:

```text
createWorkroom(input)
listWorkrooms(actorPeerId, query)
getWorkroom(workroomId, actorPeerId)
addMember(actorPeerId, membership, rekey)
createMembershipInvitation(actorPeerId, input)
listMembershipInvitations(actorPeerId)
acceptMembershipInvitation(actorPeerId, invitationId, signedConsent)
rejectMembershipInvitation(actorPeerId, invitationId)
cancelMembershipInvitation(actorPeerId, invitationId)
finalizeMembershipInvitation(actorPeerId, invitationId, rekey)
removeMember(workroomId, actorPeerId, peerId, idempotencyKey, rekey)
changeMemberRole(workroomId, actorPeerId, peerId, nextRole, idempotencyKey)
transferOwnership(workroomId, actorPeerId, nextOwnerPeerId, previousOwnerRole, idempotencyKey)
createThread(actorPeerId, thread)
appendEvent(actorPeerId, event, projection?)
listEvents(workroomId, actorPeerId, query)
updateStatus(workroomId, actorPeerId, nextStatus, idempotencyKey)
registerMandate({ signedMandate, encryptedTermsEnvelope, signedCommitment, idempotencyKey })
listMandates(workroomId, actorPeerId, query)
revokeMandate(actorPeerId, signedRevocation, idempotencyKey)
recordApprovalDecision(actorPeerId, request)
listApprovals(workroomId, actorPeerId)
appendReceipt(signedReceipt)
listReceipts(workroomId, actorPeerId, afterSequence, limit)
```

No route should bypass this service and write through the SQL repository directly.

## Create screen

Required user input is only:

- objective;
- participants (at least the current human);
- optional title and deadline.

Generate client-side UUIDs for the workroom, every initial membership and general thread. Encode
`workroomDescriptorSchema`, encrypt it under a fresh workroom content key, wrap that key for every
initial member, then call `signWorkroomEncryptedEnvelope`. Send `hashCanonical(envelope)` as
`descriptorHash`. Submit the creator plus identities controlled by that account directly in
`memberships[]`. An external agent may also be submitted when it has an active owner-approved
authorization with a controlled agent in the same workroom. Do not submit an external person
unilaterally: create the workroom with the safe initial set, then create a membership invitation for
each external person. Initial state is always `executing`; the creator is an active human `owner`,
agents may be contributors/observers, and the first thread is `general`. The descriptor and optional
thread header must wrap a key for the complete direct initial member set—not an invited person who
has not accepted.

Never send title/objective plaintext as routing metadata. Keep the decrypted descriptor in the local
encrypted store for list/detail rendering.

## Membership and rekey

Roles and UI permissions:

| Role | Read | Post work | Manage state/members | Issue/revoke as manager |
| --- | --- | --- | --- | --- |
| owner | yes | yes | yes | yes |
| supervisor | yes | yes | yes | yes |
| contributor | yes | yes | no | no |
| observer | yes | no | no | no |

For `ATALK_GROUP_BOX_V1`, every new event must wrap its content key for exactly the active member set.
Creation starts at `currentKeyEpoch: 0`. Adding or removing a member is one compare-and-swap mutation:
the client sends the expected epoch plus a newly encrypted descriptor at `expectedKeyEpoch + 1`, its
canonical hash and wrapped keys for exactly the **post-change** member set. The backend verifies the
manager signature/recipients and commits membership, descriptor and epoch in one transaction.
Idempotent replays do not increment again. This prevents adding somebody who cannot read the task
objective and prevents a removed member from retaining the next descriptor key. A stale/future epoch
fails with `WORKROOM_KEY_EPOCH_CHANGED`; refresh detail, decrypt the current descriptor, re-encrypt it
for the intended post-change recipients and retry with a fresh operation idempotency key. Historic
access is a separate explicit grant and must not be inferred from current membership. An MLS client
will instead commit the membership change to its group state.

An external person's safe flow is `PENDING → ACCEPTED → JOINED`:

1. A manager creates an invitation whose proposed membership has a stable UUID and role. Its expiry
   must be in the next seven days and cannot exceed the workroom deadline.
2. The recipient reviews the sender and proposed role, then signs
   `WorkroomMembershipConsentPayload`. `validUntil` cannot exceed the invitation expiry. Reject is an
   explicit alternative; visibility/discoverability is never treated as consent.
3. Acceptance does not expose the descriptor. The original inviting manager fetches fresh detail,
   builds the next descriptor for current members plus the invitee and calls `finalize`.
4. If another membership change won the epoch, `WORKROOM_KEY_EPOCH_CHANGED` leaves the invitation
   `ACCEPTED`. Fetch fresh detail, rebuild the rekey and retry; never ask the recipient to accept again.

Cards for incoming invitations expose Accept/Reject. Outgoing pending invitations expose Cancel;
outgoing accepted invitations expose “Confirm encrypted access” plus Cancel. Invitees see a neutral
private-task label until finalization because title/objective are E2EE and they are not recipients yet.
Bilateral blocks and deletion-pending identities are rechecked throughout the flow.

`WorkroomApprovalView` exposes only verifiable routing metadata and signed evidence: request/source
ids, requester, required M-of-N threshold, eligible peer ids, request ciphertext hash/envelope,
expiry, signed decisions plus `status`, `approveCount`, `rejectCount` and
`remainingDecisionCount`. The plaintext action/rationale remains inside the request envelope. A new
approval request moves an executing task to `waiting_approval`; once no request remains pending, an
approved latest request resumes `executing` and an impossible/rejected latest request moves to
`blocked`. Expiry is projected as `expired`; a production expiry sweeper/notification worker remains
active so state advances even when nobody opens or decides the request. `PATCH state` cannot move a
task out of `waiting_approval`, and cannot resume a blocked task while an approval is pending or the
latest request is rejected/expired. The UI must not show a generic “Resume” action in those cases;
offer approve/reject, cancel, or create a replacement approval request instead.

## Composer and explicit mentions

The composer produces one of the `workroomContentPayloadSchema` variants. Human-visible chat uses
`kind: "message"`; agent progress belongs in `kind: "activity"`, not simulated chat bubbles.

Every `@mention` is a structured value inside the encrypted payload:

```ts
{
  peerId: "uuid",
  handle: "@research.agent",
  peerType: "AGENT",
  intent: "direct" // or "fyi" / "approval_requested"
}
```

Autocomplete or the explicit audience selector must resolve handles to peer ids from active workroom
membership. Typing an `@handle` manually does not create routing: the composer blocks that unresolved
token until the user selects its canonical suggestion (or removes it), and prunes selections that are
no longer active. The selected audience shown beside the composer must be the same set serialized in
`mentions`; there is no second text-derived target set. Do not infer routing by parsing display text in
a connector.

Before encryption and again after decryption, bind every mention's `peerId`, `handle` and `peerType`
exactly to one active member, reject duplicates/stale identities/direct self-mentions, and quarantine
the event from rendering on failure. Only `intent: "direct"` starts autonomous work. `fyi` is display
context and approval actions use `approval_request`, not a mention shortcut. For plans, only assigned
steps in `executing` state may dispatch; pass `routing.assignedSteps` to the selected runtime rather
than presenting the complete plan as work it should execute. An event authored by the recipient never
dispatches back to it.

After payload validation:

1. Encrypt bytes into `WorkroomEncryptedEnvelope` and sign it.
2. Create `AppendWorkroomEvent` with the same workroom, sender, kind and a stable idempotency key.
3. Include a routing projection only for plan/artifact/deliverable/cost/approval events. Projections
   contain ids and thresholds, never plaintext content.
4. Produce the corresponding signed receipt using the latest receipt hash. A chain conflict means
   refetch, rebuild with the new previous hash and retry using a new receipt id/idempotency key.

## Recommended workroom detail IA

- **Overview:** decrypted objective, state, deadline, members and current mandate summary.
- **Timeline:** messages plus compact structured activity, newest visible at the bottom.
- **Plan:** latest immutable plan version and status per step.
- **Files:** artifacts grouped by artifact id with version history and deliverable marker.
- **Approvals:** pending first, then resolved/expired; show requested action and rationale only after
  local decryption.
- **Control:** pause/block/cancel, member roles, mandate details and revoke action.

The primary header status uses these labels: executing → “Working”, waiting approval → “Needs your
approval”, blocked → “Blocked”, completed → “Completed”, cancelled → “Cancelled”, expired →
“Expired”. Do not derive expiry from the client clock alone and do not label a queued/offline agent as
online.

Protocol v1 encrypts every Task event, including files, for every active member. The UI must say that
plainly and must not offer a per-file recipient subset. A smaller audience requires a separate Task
until recipient-scoped artifact threads exist.

## Mandate wizard

Present progressive disclosure:

1. **Goal and time:** purpose, start/end and end conditions.
2. **Who:** principal, agent, allowed participants and optional delegates.
3. **Access:** suggested actions/tools/data with an “Advanced” editor.
4. **Limits:** spend, messages/files/bytes/actions and delegation depth.
5. **Approvals:** conditions, eligible human approvers and M-of-N threshold.
6. **Review:** plain-language summary followed by local signing/encryption.

The app creates a stable `mandateId`, `revision: 1`, full `SignedMandate`, encrypted terms and signed
commitment. Editing creates revision `n + 1` and sets `supersedesTermsHash` to the previous full signed
terms hash. Never overwrite a mandate. Once a series is revoked it cannot be resumed or revised; a
replacement permission uses a new `mandateId` and starts again at revision 1. Revocation is separately
signed and should be a prominent, immediate control.

Before any tool/data/spend action, an SDK or gateway parses `mandateUseRequestSchema` and calls
`evaluateMandateUse`. `requires_approval` must stop execution and generate an approval request;
`denied` must stop execution and surface its code; only `permitted` may continue. The gateway must
first verify current revision/revocation and every signed approval—it must not accept raw approver ids
from the UI as proof.

`plan.update` is an explicit low-risk action grant presented by the permission editor and included in
the standard presets. `cost.record` is mandatory derived telemetry, not an optional capability.
`approval.request` is always available as the non-executing path for requesting consent and is not a
separate grant that could be disabled.

## Recoverable domain errors

Map these service codes to user actions rather than generic alerts:

| Code | UI response |
| --- | --- |
| `WORKROOM_STATE_CHANGED` | Refresh state and let the user retry. |
| `INVALID_WORKROOM_TRANSITION` | Disable the unavailable transition. |
| `WORKROOM_READ_ONLY` | Explain observer role and offer to request access. |
| `LAST_OWNER` | Require assigning another owner first. |
| `ENVELOPE_RECIPIENT_MISMATCH` | Refresh membership/rekey and retry encryption. |
| `WORKROOM_KEY_EPOCH_CHANGED` | Refresh task detail, rebuild recipient wraps at the returned epoch and retry. |
| `WORKROOM_MEMBER_BLOCKED` | Do not add/invite; explain that a participant block prevents the shared task. |
| `WORKROOM_AGENT_AUTHORIZATION_REQUIRED` | Open agent collaboration and create/approve the bilateral authorization. |
| `WORKROOM_MEMBERSHIP_CONSENT_REQUIRED` | Create an external-human invitation instead of direct membership. |
| `WORKROOM_INVITATION_STATE_CHANGED` | Refresh invitations and keep an accepted invitation retryable. |
| `WORKROOM_DEADLINE_PASSED` | Refresh to the server-projected `expired` state; keep history read-only. |
| `INVALID_*_SIGNATURE` | Stop; show integrity failure and do not retry silently. |
| `MANDATE_ALREADY_EXPIRED` | Ask for a new validity window. |
| `MANDATE_PARTICIPANT_NOT_MEMBER` | Add the participant or remove it from the mandate. |
| `INVALID_APPROVAL_THRESHOLD` | Reduce M or add eligible human approvers. |
| `APPROVAL_PENDING` | Open the pending approval; never offer a bypass/resume control. |
| `APPROVAL_NOT_GRANTED` | Create a replacement approval request before resuming. |
| `IDEMPOTENCY_KEY_REUSED` | Treat as a client bug; create a fresh operation key only for new intent. |
| `RECEIPT_CHAIN_CONFLICT` | Refresh chain head, re-sign a new receipt and retry. |

## Local storage and sync

Persist decrypted workroom content only in the existing encrypted device store. Sync signed ciphertext,
membership epochs, typed projections and receipts. The list screen can render state/deadline from
metadata while locked, but title/objective must remain hidden until local keys are available. On an
untrusted newly linked device, show “Downloading encrypted workroom history” rather than an empty task.

## Release gates

HTTP authentication, bounded pagination, atomic descriptor rekey, membership epoch enforcement,
role/ownership transitions, route-specific application limits, approval push/expiry reconciliation,
durable receipt replay and the complete Task UI exist. Before broad production rollout, mirror rate
limits at a shared edge when running multiple replicas, operationalize the published retention and
cryptographic-erasure controls, monitor receipt outbox and approval expiry health, and run the release smoke suite across two
humans plus two independent agent runtimes on real devices.
