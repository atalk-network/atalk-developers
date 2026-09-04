import { z } from "zod";
import { attachmentDescriptorSchema } from "./attachments.js";
import { fromUtf8, utf8 } from "./encoding.js";
import { openGroupBox, sealGroupBox, type GroupBoxRecipient } from "./group-box.js";
import { hashBase64UrlPayload, signCanonical, verifyCanonical } from "./signatures.js";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(4_096);
const opaqueCiphertext = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(5_600_000);
const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const idempotencyKey = z.string().trim().min(8).max(160);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const WORKROOM_STATUSES = [
  "executing",
  "waiting_approval",
  "blocked",
  "completed",
  "cancelled",
  "expired",
] as const;

export const WORKROOM_MEMBER_ROLES = [
  "owner",
  "supervisor",
  "contributor",
  "observer",
] as const;

/** Roles that may be named as approvers or submit an approval decision. */
export const WORKROOM_APPROVER_ROLES = [
  "owner",
  "supervisor",
] as const;

export const WORKROOM_THREAD_KINDS = [
  "general",
  "activity",
  "approval",
  "deliverable",
] as const;

export const WORKROOM_EVENT_KINDS = [
  "message",
  "activity",
  "plan",
  "artifact_version",
  "deliverable",
  "cost",
  "approval_request",
] as const;

export type WorkroomStatus = (typeof WORKROOM_STATUSES)[number];
export type WorkroomMemberRole = (typeof WORKROOM_MEMBER_ROLES)[number];
export type WorkroomApproverRole = (typeof WORKROOM_APPROVER_ROLES)[number];
export type WorkroomThreadKind = (typeof WORKROOM_THREAD_KINDS)[number];
export type WorkroomEventKind = (typeof WORKROOM_EVENT_KINDS)[number];

/** Canonical, currently active identity data used to bind encrypted routing. */
export interface WorkroomRoutingPeer {
  id: string;
  handle: string;
  type: "HUMAN" | "AGENT";
  status: "ACTIVE";
}

export const workroomApproverRoleSchema = z.enum(WORKROOM_APPROVER_ROLES);

export const workroomDescriptorSchema = z.object({
  version: z.literal(1),
  title: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().min(1).max(4_000),
  deadline: instant.optional(),
}).strict();

export const workroomMemberSchema = z.object({
  peerId: uuid,
  peerType: z.enum(["HUMAN", "AGENT"] as const),
  role: z.enum(WORKROOM_MEMBER_ROLES),
  joinedAt: instant,
  leftAt: instant.optional(),
}).strict();

export const workroomMentionSchema = z.object({
  peerId: uuid,
  handle: z.string().regex(/^@[a-z0-9][a-z0-9._-]{1,62}$/u),
  peerType: z.enum(["HUMAN", "AGENT"] as const),
  intent: z.enum(["direct", "fyi", "approval_requested"] as const).default("direct"),
}).strict();

const encryptedEnvelopeBaseSchema = z.object({
  version: z.literal(1),
  envelopeId: uuid,
  workroomId: uuid,
  senderPeerId: uuid,
  keyEpoch: z.number().int().nonnegative(),
  ciphertext: opaqueCiphertext,
  ciphertextHash: base64Url,
  createdAt: instant,
});

const wrappedWorkroomKeySchema = z.object({
  recipientPeerId: uuid,
  nonce: base64Url,
  ciphertext: base64Url,
}).strict();

/**
 * Opaque group payload retained by the relay. Neither variant exposes the
 * descriptor, message, mentions, plan, artifacts, costs, or approval reason.
 */
export const unsignedWorkroomEncryptedEnvelopeSchema = z.discriminatedUnion("cipherSuite", [
  encryptedEnvelopeBaseSchema.extend({
    cipherSuite: z.literal("ATALK_GROUP_BOX_V1"),
    nonce: base64Url,
    wrappedKeys: z.array(wrappedWorkroomKeySchema).min(1).max(1_000),
  }).strict(),
  encryptedEnvelopeBaseSchema.extend({
    cipherSuite: z.literal("MLS_1_0"),
  }).strict(),
]).superRefine((envelope, context) => {
  if (envelope.cipherSuite === "ATALK_GROUP_BOX_V1"
    && new Set(envelope.wrappedKeys.map(({ recipientPeerId }) => recipientPeerId)).size !== envelope.wrappedKeys.length) {
    context.addIssue({ code: "custom", message: "Wrapped-key recipients must be unique", path: ["wrappedKeys"] });
  }
});

export const workroomEncryptedEnvelopeSchema = z.discriminatedUnion("cipherSuite", [
  encryptedEnvelopeBaseSchema.extend({
    cipherSuite: z.literal("ATALK_GROUP_BOX_V1"),
    nonce: base64Url,
    wrappedKeys: z.array(wrappedWorkroomKeySchema).min(1).max(1_000),
    senderSignature: base64Url,
  }).strict(),
  encryptedEnvelopeBaseSchema.extend({
    cipherSuite: z.literal("MLS_1_0"),
    senderSignature: base64Url,
  }).strict(),
]).superRefine((envelope, context) => {
  if (envelope.cipherSuite === "ATALK_GROUP_BOX_V1"
    && new Set(envelope.wrappedKeys.map(({ recipientPeerId }) => recipientPeerId)).size !== envelope.wrappedKeys.length) {
    context.addIssue({ code: "custom", message: "Wrapped-key recipients must be unique", path: ["wrappedKeys"] });
  }
});

export const workroomSchema = z.object({
  id: uuid,
  createdByPeerId: uuid,
  status: z.enum(WORKROOM_STATUSES),
  deadline: instant.optional(),
  descriptorEnvelope: workroomEncryptedEnvelopeSchema,
  createdAt: instant,
  updatedAt: instant,
}).strict();

export const workroomThreadSchema = z.object({
  id: uuid,
  workroomId: uuid,
  kind: z.enum(WORKROOM_THREAD_KINDS),
  createdByPeerId: uuid,
  headerEnvelope: workroomEncryptedEnvelopeSchema.optional(),
  createdAt: instant,
}).strict();

export const workroomMessagePayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("message"),
  threadId: uuid,
  body: z.string().min(1).max(200_000),
  mentions: z.array(workroomMentionSchema).max(100).default([]),
  replyToEventId: uuid.optional(),
}).strict();

export const workroomActivityPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("activity"),
  threadId: uuid,
  activityType: identifier,
  summary: z.string().trim().min(1).max(4_000),
  mentions: z.array(workroomMentionSchema).max(100).default([]),
  sourceEventIds: z.array(uuid).max(100).default([]),
  attributes: z.record(z.string().max(80), z.string().max(4_000)).default({}),
}).strict();

export const workroomPlanStepSchema = z.object({
  id: identifier,
  title: z.string().trim().min(1).max(500),
  status: z.enum(WORKROOM_STATUSES),
  assignedPeerIds: z.array(uuid).max(100).default([]),
  dependsOnStepIds: z.array(identifier).max(100).default([]),
  deadline: instant.optional(),
}).strict();

export const workroomPlanPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("plan"),
  planId: uuid.optional(),
  planVersion: z.number().int().positive(),
  summary: z.string().trim().min(1).max(2_000),
  steps: z.array(workroomPlanStepSchema).min(1).max(500),
}).strict().superRefine((plan, context) => {
  const stepIds = new Set(plan.steps.map((step) => step.id));
  if (stepIds.size !== plan.steps.length) {
    context.addIssue({ code: "custom", message: "Plan step ids must be unique", path: ["steps"] });
  }
  for (const [index, step] of plan.steps.entries()) {
    if (step.dependsOnStepIds.includes(step.id)) {
      context.addIssue({ code: "custom", message: "A step cannot depend on itself", path: ["steps", index, "dependsOnStepIds"] });
    }
    for (const dependencyId of step.dependsOnStepIds) {
      if (!stepIds.has(dependencyId)) {
        context.addIssue({ code: "custom", message: "Unknown plan dependency", path: ["steps", index, "dependsOnStepIds"] });
      }
    }
  }
});

export const workroomArtifactVersionPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("artifact_version"),
  artifactId: uuid,
  artifactVersion: z.number().int().positive(),
  artifactVersionId: uuid.optional(),
  artifactType: identifier,
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(4_000).optional(),
  mediaType: z.string().trim().min(1).max(200).optional(),
  fileName: z.string().trim().min(1).max(500).optional(),
  attachmentIds: z.array(uuid).max(100).default([]),
  /** Descriptors are optional for compatibility with pre-file workroom events. */
  attachments: z.array(attachmentDescriptorSchema).max(100).optional(),
  contentHash: base64Url,
  previousVersionHash: base64Url.optional(),
  mentions: z.array(workroomMentionSchema).max(100).default([]),
}).strict().superRefine((artifact, context) => {
  if (!artifact.attachments) return;
  const descriptorIds = artifact.attachments.map(({ id }) => id);
  if (new Set(descriptorIds).size !== descriptorIds.length) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Attachment descriptor ids must be unique" });
  }
  if (descriptorIds.length !== artifact.attachmentIds.length
    || descriptorIds.some((id, index) => id !== artifact.attachmentIds[index])) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Attachment descriptors must match attachmentIds in order" });
  }
});

export const workroomDeliverablePayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("deliverable"),
  artifactId: uuid,
  artifactVersion: z.number().int().positive(),
  artifactVersionId: uuid.optional(),
  deliverableId: uuid.optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1_000)).min(1).max(100),
  note: z.string().trim().max(4_000).optional(),
  mentions: z.array(workroomMentionSchema).max(100).default([]),
}).strict();

export const workroomCostPayloadSchema = z.discriminatedUnion("metric", [
  z.object({
    version: z.literal(1),
    kind: z.literal("cost"),
    costId: uuid.optional(),
    metric: z.literal("money"),
    currency: z.string().regex(/^[A-Z]{3}$/u),
    amountMinor: safeCount,
    provider: z.string().trim().min(1).max(160).optional(),
    relatedEventId: uuid.optional(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("cost"),
    costId: uuid.optional(),
    metric: z.literal("tokens"),
    provider: z.string().trim().min(1).max(160),
    model: z.string().trim().min(1).max(160).optional(),
    inputTokens: safeCount,
    outputTokens: safeCount,
    relatedEventId: uuid.optional(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("cost"),
    costId: uuid.optional(),
    metric: z.literal("duration_ms"),
    durationMs: safeCount,
    provider: z.string().trim().min(1).max(160).optional(),
    relatedEventId: uuid.optional(),
  }).strict(),
  z.object({
    version: z.literal(1),
    kind: z.literal("cost"),
    costId: uuid.optional(),
    metric: z.literal("custom"),
    unit: identifier,
    quantity: safeCount,
    relatedEventId: uuid.optional(),
  }).strict(),
]);

export const workroomApprovalRequestPayloadSchema = z.object({
  version: z.literal(1),
  kind: z.literal("approval_request"),
  requestId: uuid.optional(),
  thresholdId: identifier.optional(),
  action: identifier,
  rationale: z.string().trim().min(1).max(4_000),
  /** Human-readable consent context; optional only for legacy version-1 events. */
  summary: z.string().trim().min(1).max(1_000).optional(),
  target: z.object({
    type: identifier,
    label: z.string().trim().min(1).max(500),
    reference: z.string().trim().min(1).max(1_000).optional(),
  }).strict().optional(),
  effect: z.string().trim().min(1).max(2_000).optional(),
  financialImpact: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/u),
    amountMinor: safeCount,
    kind: z.enum(["exact", "maximum"] as const),
  }).strict().optional(),
  dataCategories: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  mandateId: uuid.optional(),
  relatedEventIds: z.array(uuid).max(100).default([]),
  requestedApproverPeerIds: z.array(uuid).min(1).max(100),
  requiredApprovals: z.number().int().positive().max(100),
  expiresAt: instant.optional(),
}).strict().superRefine((request, context) => {
  if (request.requiredApprovals > new Set(request.requestedApproverPeerIds).size) {
    context.addIssue({ code: "custom", message: "Approval threshold exceeds unique eligible approvers", path: ["requiredApprovals"] });
  }
});

export const workroomApprovalDecisionPayloadSchema = z.object({
  version: z.literal(1),
  decisionId: uuid,
  requestId: uuid,
  workroomId: uuid,
  decidedByPeerId: uuid,
  decision: z.enum(["approve", "reject"] as const),
  requestCiphertextHash: base64Url,
  encryptedReasonHash: base64Url.optional(),
  decidedAt: instant,
}).strict();

export const signedWorkroomApprovalDecisionSchema = z.object({
  decision: workroomApprovalDecisionPayloadSchema,
  signature: base64Url,
}).strict();

/**
 * A peer's explicit, narrowly-scoped acceptance of one workroom membership.
 * Binding the consent to the generated membership id prevents it from being
 * reused to silently re-add a peer after they leave the workroom.
 */
export const workroomMembershipConsentPayloadSchema = z.object({
  version: z.literal(1),
  consentId: uuid,
  workroomId: uuid,
  membershipId: uuid,
  invitedByPeerId: uuid,
  memberPeerId: uuid,
  peerType: z.enum(["HUMAN", "AGENT"] as const),
  role: z.enum(WORKROOM_MEMBER_ROLES),
  acceptedAt: instant,
  validUntil: instant,
}).strict().superRefine((consent, context) => {
  if (Date.parse(consent.validUntil) <= Date.parse(consent.acceptedAt)) {
    context.addIssue({ code: "custom", message: "Membership consent must expire after acceptance", path: ["validUntil"] });
  }
});

export const signedWorkroomMembershipConsentSchema = z.object({
  consent: workroomMembershipConsentPayloadSchema,
  signature: base64Url,
}).strict();

export const workroomContentPayloadSchema = z.discriminatedUnion("kind", [
  workroomMessagePayloadSchema,
  workroomActivityPayloadSchema,
  workroomPlanPayloadSchema,
  workroomArtifactVersionPayloadSchema,
  workroomDeliverablePayloadSchema,
  workroomCostPayloadSchema,
  workroomApprovalRequestPayloadSchema,
]);

export const appendWorkroomEventSchema = z.object({
  eventId: uuid,
  workroomId: uuid,
  threadId: uuid,
  actorPeerId: uuid,
  kind: z.enum(WORKROOM_EVENT_KINDS),
  envelope: workroomEncryptedEnvelopeSchema,
  idempotencyKey,
  createdAt: instant,
}).strict().superRefine((event, context) => {
  if (event.envelope.workroomId !== event.workroomId) {
    context.addIssue({ code: "custom", message: "Envelope belongs to another workroom", path: ["envelope", "workroomId"] });
  }
  if (event.envelope.senderPeerId !== event.actorPeerId) {
    context.addIssue({ code: "custom", message: "Envelope sender must match event actor", path: ["envelope", "senderPeerId"] });
  }
});

export type WorkroomDescriptor = z.infer<typeof workroomDescriptorSchema>;
export type WorkroomMember = z.infer<typeof workroomMemberSchema>;
export type WorkroomMention = z.infer<typeof workroomMentionSchema>;
export type UnsignedWorkroomEncryptedEnvelope = z.infer<typeof unsignedWorkroomEncryptedEnvelopeSchema>;
export type WorkroomEncryptedEnvelope = z.infer<typeof workroomEncryptedEnvelopeSchema>;
export type Workroom = z.infer<typeof workroomSchema>;
export type WorkroomThread = z.infer<typeof workroomThreadSchema>;
export type WorkroomContentPayload = z.infer<typeof workroomContentPayloadSchema>;
export type WorkroomPlanStep = z.infer<typeof workroomPlanStepSchema>;
export type AppendWorkroomEvent = z.infer<typeof appendWorkroomEventSchema>;
export type WorkroomApprovalDecisionPayload = z.infer<typeof workroomApprovalDecisionPayloadSchema>;
export type SignedWorkroomApprovalDecision = z.infer<typeof signedWorkroomApprovalDecisionSchema>;
export type WorkroomMembershipConsentPayload = z.infer<typeof workroomMembershipConsentPayloadSchema>;
export type SignedWorkroomMembershipConsent = z.infer<typeof signedWorkroomMembershipConsentSchema>;

export interface WorkroomRoutingMatch {
  /** Only direct mentions and executable assignments may start an autonomous turn. */
  directedToMe: boolean;
  directMentions: WorkroomMention[];
  /** The exact executable plan steps assigned to this identity, never the whole plan. */
  assignedSteps: WorkroomPlanStep[];
}

function payloadMentions(content: WorkroomContentPayload): WorkroomMention[] {
  return "mentions" in content ? content.mentions : [];
}

/**
 * Binds every encrypted routing reference to the canonical active member set.
 * This must run both before encryption and after decryption: a syntactically
 * valid triple is not an identity unless id, handle and peer type all agree.
 */
export function validateWorkroomContentRouting(
  content: WorkroomContentPayload,
  activePeers: readonly WorkroomRoutingPeer[],
  actorPeerId: string,
): void {
  const peers = new Map<string, WorkroomRoutingPeer>();
  for (const peer of activePeers) {
    if (peer.status !== "ACTIVE" || (peer.type !== "HUMAN" && peer.type !== "AGENT")) {
      throw new Error("WORKROOM_ROUTING_MEMBER_INVALID");
    }
    if (peers.has(peer.id)) throw new Error("WORKROOM_MEMBER_DUPLICATE");
    peers.set(peer.id, peer);
  }

  const mentioned = new Set<string>();
  for (const mention of payloadMentions(content)) {
    if (mentioned.has(mention.peerId)) throw new Error("WORKROOM_ROUTING_DUPLICATE_TARGET");
    mentioned.add(mention.peerId);
    if (mention.peerId === actorPeerId && mention.intent === "direct") {
      throw new Error("WORKROOM_SELF_DIRECTION_FORBIDDEN");
    }
    const peer = peers.get(mention.peerId);
    if (!peer) throw new Error("WORKROOM_ROUTING_TARGET_NOT_ACTIVE");
    if (peer.handle !== mention.handle || peer.type !== mention.peerType) {
      throw new Error("WORKROOM_ROUTING_IDENTITY_MISMATCH");
    }
  }

  if (content.kind !== "plan") return;
  for (const step of content.steps) {
    const assigned = new Set<string>();
    for (const peerId of step.assignedPeerIds) {
      if (assigned.has(peerId)) throw new Error("WORKROOM_ROUTING_DUPLICATE_TARGET");
      assigned.add(peerId);
      if (!peers.has(peerId)) throw new Error("WORKROOM_ROUTING_TARGET_NOT_ACTIVE");
    }
  }
}

/** Computes the narrow context that an autonomous runtime is allowed to see. */
export function resolveWorkroomRouting(
  content: WorkroomContentPayload,
  recipientPeerId: string,
  actorPeerId: string,
): WorkroomRoutingMatch {
  if (recipientPeerId === actorPeerId) {
    return { directedToMe: false, directMentions: [], assignedSteps: [] };
  }
  const directMentions = payloadMentions(content)
    .filter((mention) => mention.peerId === recipientPeerId && mention.intent === "direct");
  const assignedSteps = content.kind === "plan"
    ? content.steps.filter((step) => step.status === "executing" && step.assignedPeerIds.includes(recipientPeerId))
    : [];
  return {
    directedToMe: directMentions.length > 0 || assignedSteps.length > 0,
    directMentions,
    assignedSteps,
  };
}

export function signWorkroomEncryptedEnvelope(
  value: UnsignedWorkroomEncryptedEnvelope,
  signingSecretKey: string,
): WorkroomEncryptedEnvelope {
  const parsed = unsignedWorkroomEncryptedEnvelopeSchema.parse(value);
  if (hashBase64UrlPayload(parsed.ciphertext) !== parsed.ciphertextHash) {
    throw new Error("WORKROOM_CIPHERTEXT_HASH_MISMATCH");
  }
  return workroomEncryptedEnvelopeSchema.parse({
    ...parsed,
    senderSignature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyWorkroomEncryptedEnvelope(
  value: WorkroomEncryptedEnvelope,
  signingPublicKey: string,
): boolean {
  const parsed = workroomEncryptedEnvelopeSchema.safeParse(value);
  if (!parsed.success || hashBase64UrlPayload(parsed.data.ciphertext) !== parsed.data.ciphertextHash) return false;
  const { senderSignature, ...unsigned } = parsed.data;
  return verifyCanonical(unsigned, senderSignature, signingPublicKey);
}

export interface EncryptWorkroomPayloadInput {
  envelopeId: string;
  workroomId: string;
  senderPeerId: string;
  keyEpoch: number;
  payload: unknown;
  senderSigningSecretKey: string;
  senderEncryptionSecretKey: string;
  recipients: GroupBoxRecipient[];
  createdAt: string;
  randomBytes?: (length: number) => Uint8Array;
}

/** Encrypts and signs a JSON payload for an exact workroom member set. */
export function encryptWorkroomPayload(input: EncryptWorkroomPayloadInput): WorkroomEncryptedEnvelope {
  const sealed = sealGroupBox({
    plaintext: utf8(JSON.stringify(input.payload)),
    senderEncryptionSecretKey: input.senderEncryptionSecretKey,
    recipients: input.recipients,
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
  });
  return signWorkroomEncryptedEnvelope({
    version: 1,
    cipherSuite: "ATALK_GROUP_BOX_V1",
    envelopeId: input.envelopeId,
    workroomId: input.workroomId,
    senderPeerId: input.senderPeerId,
    keyEpoch: input.keyEpoch,
    ...sealed,
    ciphertextHash: hashBase64UrlPayload(sealed.ciphertext),
    createdAt: input.createdAt,
  }, input.senderSigningSecretKey);
}

export interface DecryptWorkroomPayloadInput {
  envelope: WorkroomEncryptedEnvelope;
  recipientPeerId: string;
  recipientEncryptionSecretKey: string;
  senderEncryptionPublicKey: string;
  senderSigningPublicKey: string;
}

/** Verifies, decrypts and parses a workroom JSON payload on the device/runtime. */
export function decryptWorkroomPayload<T = unknown>(input: DecryptWorkroomPayloadInput): T {
  if (!verifyWorkroomEncryptedEnvelope(input.envelope, input.senderSigningPublicKey)) {
    throw new Error("INVALID_WORKROOM_ENVELOPE");
  }
  if (input.envelope.cipherSuite !== "ATALK_GROUP_BOX_V1") throw new Error("WORKROOM_CIPHER_SUITE_UNSUPPORTED");
  const plaintext = openGroupBox({
    nonce: input.envelope.nonce,
    ciphertext: input.envelope.ciphertext,
    wrappedKeys: input.envelope.wrappedKeys,
    recipientPeerId: input.recipientPeerId,
    recipientEncryptionSecretKey: input.recipientEncryptionSecretKey,
    senderEncryptionPublicKey: input.senderEncryptionPublicKey,
  });
  try {
    return JSON.parse(fromUtf8(plaintext)) as T;
  } catch {
    throw new Error("INVALID_WORKROOM_PAYLOAD");
  }
}

export function signWorkroomApprovalDecision(
  value: WorkroomApprovalDecisionPayload,
  signingSecretKey: string,
): SignedWorkroomApprovalDecision {
  const parsed = workroomApprovalDecisionPayloadSchema.parse(value);
  return signedWorkroomApprovalDecisionSchema.parse({
    decision: parsed,
    signature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyWorkroomApprovalDecision(
  value: SignedWorkroomApprovalDecision,
  signingPublicKey: string,
): boolean {
  const parsed = signedWorkroomApprovalDecisionSchema.safeParse(value);
  return parsed.success && verifyCanonical(parsed.data.decision, parsed.data.signature, signingPublicKey);
}

export function signWorkroomMembershipConsent(
  value: WorkroomMembershipConsentPayload,
  signingSecretKey: string,
): SignedWorkroomMembershipConsent {
  const parsed = workroomMembershipConsentPayloadSchema.parse(value);
  return signedWorkroomMembershipConsentSchema.parse({
    consent: parsed,
    signature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyWorkroomMembershipConsent(
  value: SignedWorkroomMembershipConsent,
  signingPublicKey: string,
): boolean {
  const parsed = signedWorkroomMembershipConsentSchema.safeParse(value);
  return parsed.success && verifyCanonical(parsed.data.consent, parsed.data.signature, signingPublicKey);
}

export { idempotencyKey as workroomIdempotencyKeySchema };
