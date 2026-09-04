import { z } from "zod";
import { fromUtf8, utf8 } from "./encoding.js";
import { openGroupBox, sealGroupBox, type GroupBoxRecipient } from "./group-box.js";
import { hashBase64UrlPayload, hashCanonical, signCanonical, verifyCanonical } from "./signatures.js";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(4_096);
const opaqueCiphertext = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(5_600_000);
const identifier = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const positiveLimit = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const mandateDataGrantSchema = z.object({
  resource: identifier,
  permissions: z.array(z.enum(["read", "write", "share"] as const)).min(1).max(3),
  classification: z.string().trim().min(1).max(120).optional(),
  allowedRecipientPeerIds: z.array(uuid).max(100).default([]),
}).strict();

export const mandateToolGrantSchema = z.object({
  tool: identifier,
  actions: z.array(identifier).min(1).max(100),
  audience: z.string().trim().min(1).max(300).optional(),
}).strict();

export const mandateSpendLimitSchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/u),
  maximumAmountMinor: positiveLimit,
  maximumPerOperationMinor: positiveLimit.optional(),
  period: z.enum(["mandate", "day", "week", "month"] as const).default("mandate"),
}).strict().superRefine((limit, context) => {
  if (limit.maximumPerOperationMinor !== undefined
    && limit.maximumPerOperationMinor > limit.maximumAmountMinor) {
    context.addIssue({
      code: "custom",
      message: "Per-operation spend cannot exceed the total spend limit",
      path: ["maximumPerOperationMinor"],
    });
  }
});

export const mandateVolumeLimitsSchema = z.object({
  maxMessages: positiveLimit.optional(),
  maxFiles: positiveLimit.optional(),
  maxTotalBytes: positiveLimit.optional(),
  maxActions: positiveLimit.optional(),
  custom: z.record(identifier, positiveLimit).default({}),
}).strict().superRefine((limits, context) => {
  if (
    limits.maxMessages === undefined
    && limits.maxFiles === undefined
    && limits.maxTotalBytes === undefined
    && limits.maxActions === undefined
    && Object.keys(limits.custom).length === 0
  ) {
    context.addIssue({ code: "custom", message: "At least one volume limit is required" });
  }
});

export const mandateDelegationSchema = z.object({
  allowed: z.boolean(),
  maxDepth: z.number().int().min(0).max(8),
  allowedDelegatePeerIds: z.array(uuid).max(100).default([]),
  requirePrincipalApproval: z.boolean().default(true),
}).strict().superRefine((delegation, context) => {
  if (!delegation.allowed && (delegation.maxDepth !== 0 || delegation.allowedDelegatePeerIds.length > 0)) {
    context.addIssue({ code: "custom", message: "Disabled delegation cannot define delegates or depth" });
  }
  if (delegation.allowed && delegation.maxDepth < 1) {
    context.addIssue({ code: "custom", message: "Enabled delegation requires positive depth", path: ["maxDepth"] });
  }
});

const approvalConditionSchema = z.object({
  action: identifier.optional(),
  tool: identifier.optional(),
  amountAboveMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/u).optional(),
  dataClassification: z.string().trim().min(1).max(120).optional(),
}).strict().superRefine((condition, context) => {
  const populated = Object.values(condition).some((value) => value !== undefined);
  if (!populated) context.addIssue({ code: "custom", message: "Approval condition cannot be empty" });
  if ((condition.amountAboveMinor === undefined) !== (condition.currency === undefined)) {
    context.addIssue({ code: "custom", message: "Amount threshold and currency must be provided together" });
  }
});

export const mandateApprovalThresholdSchema = z.object({
  id: identifier,
  when: approvalConditionSchema,
  requiredApprovals: z.number().int().positive().max(100),
  approverPeerIds: z.array(uuid).min(1).max(100),
}).strict().superRefine((threshold, context) => {
  if (threshold.requiredApprovals > new Set(threshold.approverPeerIds).size) {
    context.addIssue({ code: "custom", message: "Approval threshold exceeds unique approvers", path: ["requiredApprovals"] });
  }
});

export const mandateEndConditionSchema = z.discriminatedUnion("type", [
  z.object({ id: identifier, type: z.literal("deadline"), at: instant }).strict(),
  z.object({ id: identifier, type: z.literal("deliverable_accepted"), artifactId: uuid.optional() }).strict(),
  z.object({ id: identifier, type: z.literal("budget_exhausted"), currency: z.string().regex(/^[A-Z]{3}$/u).optional() }).strict(),
  z.object({ id: identifier, type: z.literal("volume_exhausted"), metric: identifier }).strict(),
  z.object({ id: identifier, type: z.literal("workroom_completed") }).strict(),
  z.object({ id: identifier, type: z.literal("explicit_revocation") }).strict(),
]);

export const unsignedMandateSchema = z.object({
  version: z.literal(1),
  mandateId: uuid,
  revision: z.number().int().positive(),
  supersedesTermsHash: base64Url.optional(),
  workroomId: uuid.optional(),
  principalPeerId: uuid,
  actorPeerId: uuid,
  issuedByPeerId: uuid,
  purpose: z.string().trim().min(1).max(4_000),
  allowedParticipantPeerIds: z.array(uuid).min(1).max(1_000),
  allowedData: z.array(mandateDataGrantSchema).max(500).default([]),
  allowedTools: z.array(mandateToolGrantSchema).max(500).default([]),
  allowedActions: z.array(identifier).max(1_000).default([]),
  spendLimits: z.array(mandateSpendLimitSchema).max(100).default([]),
  volumeLimits: mandateVolumeLimitsSchema.optional(),
  validFrom: instant,
  validUntil: instant,
  delegation: mandateDelegationSchema,
  approvalThresholds: z.array(mandateApprovalThresholdSchema).max(100).default([]),
  endConditions: z.array(mandateEndConditionSchema).min(1).max(100),
  nonce: base64Url,
}).strict().superRefine((mandate, context) => {
  if (mandate.revision === 1 && mandate.supersedesTermsHash !== undefined) {
    context.addIssue({ code: "custom", message: "The first mandate revision cannot supersede earlier terms", path: ["supersedesTermsHash"] });
  }
  if (mandate.revision > 1 && mandate.supersedesTermsHash === undefined) {
    context.addIssue({ code: "custom", message: "Later mandate revisions must bind the previous terms hash", path: ["supersedesTermsHash"] });
  }
  if (mandate.principalPeerId === mandate.actorPeerId) {
    context.addIssue({ code: "custom", message: "Principal and actor must be distinct", path: ["actorPeerId"] });
  }
  if (!mandate.allowedParticipantPeerIds.includes(mandate.actorPeerId)) {
    context.addIssue({ code: "custom", message: "Actor must be an allowed participant", path: ["allowedParticipantPeerIds"] });
  }
  if (!mandate.allowedParticipantPeerIds.includes(mandate.principalPeerId)) {
    context.addIssue({ code: "custom", message: "Principal must be an allowed participant", path: ["allowedParticipantPeerIds"] });
  }
  if (new Set(mandate.allowedParticipantPeerIds).size !== mandate.allowedParticipantPeerIds.length) {
    context.addIssue({ code: "custom", message: "Allowed participants must be unique", path: ["allowedParticipantPeerIds"] });
  }
  if (Date.parse(mandate.validUntil) <= Date.parse(mandate.validFrom)) {
    context.addIssue({ code: "custom", message: "Mandate validity must end after it starts", path: ["validUntil"] });
  }
  const participants = new Set(mandate.allowedParticipantPeerIds);
  for (const [index, grant] of mandate.allowedData.entries()) {
    if (grant.allowedRecipientPeerIds.some((peerId) => !participants.has(peerId))) {
      context.addIssue({ code: "custom", message: "Data recipients must be allowed participants", path: ["allowedData", index, "allowedRecipientPeerIds"] });
    }
  }
  if (mandate.delegation.allowedDelegatePeerIds.some((peerId) => !participants.has(peerId))) {
    context.addIssue({ code: "custom", message: "Delegates must be allowed participants", path: ["delegation", "allowedDelegatePeerIds"] });
  }
  for (const [index, threshold] of mandate.approvalThresholds.entries()) {
    if (threshold.approverPeerIds.some((peerId) => !participants.has(peerId))) {
      context.addIssue({ code: "custom", message: "Approvers must be allowed participants", path: ["approvalThresholds", index, "approverPeerIds"] });
    }
  }
  if (new Set(mandate.approvalThresholds.map(({ id }) => id)).size !== mandate.approvalThresholds.length) {
    context.addIssue({ code: "custom", message: "Approval threshold ids must be unique", path: ["approvalThresholds"] });
  }
  if (new Set(mandate.endConditions.map(({ id }) => id)).size !== mandate.endConditions.length) {
    context.addIssue({ code: "custom", message: "End condition ids must be unique", path: ["endConditions"] });
  }
  const spendLimitKeys = mandate.spendLimits.map(({ currency, period }) => `${currency}:${period}`);
  if (new Set(spendLimitKeys).size !== spendLimitKeys.length) {
    context.addIssue({ code: "custom", message: "Spend limits must be unique per currency and period", path: ["spendLimits"] });
  }
});

export const signedMandateSchema = z.object({
  mandate: unsignedMandateSchema,
  signedAt: instant,
  signature: base64Url,
}).strict().superRefine((signed, context) => {
  if (Date.parse(signed.signedAt) >= Date.parse(signed.mandate.validUntil)) {
    context.addIssue({ code: "custom", message: "Mandate must be signed before it expires", path: ["signedAt"] });
  }
});

const mandateWrappedKeySchema = z.object({
  recipientPeerId: uuid,
  nonce: base64Url,
  ciphertext: base64Url,
}).strict();

/** Opaque encrypted copy of the signed terms retained by an untrusted relay. */
export const unsignedMandateEncryptedTermsEnvelopeSchema = z.object({
  version: z.literal(1),
  cipherSuite: z.literal("ATALK_GROUP_BOX_V1"),
  envelopeId: uuid,
  mandateId: uuid,
  revision: z.number().int().positive(),
  senderPeerId: uuid,
  nonce: base64Url,
  ciphertext: opaqueCiphertext,
  ciphertextHash: base64Url,
  wrappedKeys: z.array(mandateWrappedKeySchema).min(1).max(1_000),
  createdAt: instant,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.wrappedKeys.map(({ recipientPeerId }) => recipientPeerId)).size !== envelope.wrappedKeys.length) {
    context.addIssue({ code: "custom", message: "Wrapped-key recipients must be unique", path: ["wrappedKeys"] });
  }
});

export const mandateEncryptedTermsEnvelopeSchema = z.object({
  version: z.literal(1),
  cipherSuite: z.literal("ATALK_GROUP_BOX_V1"),
  envelopeId: uuid,
  mandateId: uuid,
  revision: z.number().int().positive(),
  senderPeerId: uuid,
  nonce: base64Url,
  ciphertext: opaqueCiphertext,
  ciphertextHash: base64Url,
  senderSignature: base64Url,
  wrappedKeys: z.array(mandateWrappedKeySchema).min(1).max(1_000),
  createdAt: instant,
}).strict().superRefine((envelope, context) => {
  if (new Set(envelope.wrappedKeys.map(({ recipientPeerId }) => recipientPeerId)).size !== envelope.wrappedKeys.length) {
    context.addIssue({ code: "custom", message: "Wrapped-key recipients must be unique", path: ["wrappedKeys"] });
  }
});

export const mandateCommitmentPayloadSchema = z.object({
  version: z.literal(1),
  mandateId: uuid,
  revision: z.number().int().positive(),
  workroomId: uuid.optional(),
  principalPeerId: uuid,
  actorPeerId: uuid,
  issuedByPeerId: uuid,
  validFrom: instant,
  validUntil: instant,
  termsHash: base64Url,
  encryptedTermsHash: base64Url,
  committedAt: instant,
}).strict();

export const signedMandateCommitmentSchema = z.object({
  commitment: mandateCommitmentPayloadSchema,
  signature: base64Url,
}).strict();

export const mandateRevocationPayloadSchema = z.object({
  version: z.literal(1),
  revocationId: uuid,
  mandateId: uuid,
  revokedByPeerId: uuid,
  revokedAt: instant,
  reasonCode: identifier,
  encryptedReasonHash: base64Url.optional(),
}).strict();

export const signedMandateRevocationSchema = z.object({
  revocation: mandateRevocationPayloadSchema,
  signature: base64Url,
}).strict();

const mandateUseDataAccessSchema = z.object({
  resource: identifier,
  permission: z.enum(["read", "write", "share"] as const),
  recipientPeerIds: z.array(uuid).max(100).default([]),
  classification: z.string().trim().min(1).max(120).optional(),
}).strict();

const mandateUseVolumeSchema = z.object({
  messages: z.number().int().nonnegative().default(0),
  files: z.number().int().nonnegative().default(0),
  totalBytes: z.number().int().nonnegative().default(0),
  actions: z.number().int().nonnegative().default(0),
  custom: z.record(identifier, z.number().int().nonnegative()).default({}),
}).strict();

/**
 * Runtime/gateway input for deterministic mandate enforcement. Approval ids
 * are accepted only after their signatures and eligibility were verified by
 * the caller; the evaluator deliberately has no network or storage access.
 */
export const mandateUseRequestSchema = z.object({
  mandateId: uuid,
  revision: z.number().int().positive(),
  actingPeerId: uuid,
  participantPeerIds: z.array(uuid).max(1_000).default([]),
  action: identifier,
  tool: z.object({
    tool: identifier,
    action: identifier,
    audience: z.string().trim().min(1).max(2_048).optional(),
  }).strict().optional(),
  dataAccesses: z.array(mandateUseDataAccessSchema).max(500).default([]),
  spend: z.object({ currency: z.string().regex(/^[A-Z]{3}$/u), amountMinor: safeCount }).strict().optional(),
  spendUsedMinorByLimit: z.record(z.string().regex(/^[A-Z]{3}:(mandate|day|week|month)$/u), safeCount).default({}),
  volumeUsed: mandateUseVolumeSchema.default({ messages: 0, files: 0, totalBytes: 0, actions: 0, custom: {} }),
  volumeDelta: mandateUseVolumeSchema.default({ messages: 0, files: 0, totalBytes: 0, actions: 0, custom: {} }),
  delegationDepth: z.number().int().nonnegative().max(8).default(0),
  principalApprovedDelegation: z.boolean().default(false),
  verifiedApprovals: z.array(z.object({
    thresholdId: identifier,
    decisionIds: z.array(uuid).min(1).max(100),
    approverPeerIds: z.array(uuid).min(1).max(100),
  }).strict()).max(100).default([]),
  metEndConditionIds: z.array(identifier).max(100).default([]),
  evaluatedAt: instant,
}).strict();

export type MandateUseDenialCode =
  | "MANDATE_MISMATCH"
  | "MANDATE_NOT_YET_VALID"
  | "MANDATE_EXPIRED"
  | "MANDATE_ENDED"
  | "DELEGATION_DENIED"
  | "DELEGATION_DEPTH_EXCEEDED"
  | "PARTICIPANT_DENIED"
  | "ACTION_DENIED"
  | "TOOL_DENIED"
  | "DATA_DENIED"
  | "SPEND_LIMIT_EXCEEDED"
  | "VOLUME_LIMIT_EXCEEDED";

export type MandateUseDecision =
  | { status: "permitted" }
  | { status: "requires_approval"; thresholdIds: string[]; reason: "THRESHOLD" | "DELEGATION" }
  | { status: "denied"; code: MandateUseDenialCode; detail?: string };

export type UnsignedMandate = z.infer<typeof unsignedMandateSchema>;
export type SignedMandate = z.infer<typeof signedMandateSchema>;
export type UnsignedMandateEncryptedTermsEnvelope = z.infer<typeof unsignedMandateEncryptedTermsEnvelopeSchema>;
export type MandateEncryptedTermsEnvelope = z.infer<typeof mandateEncryptedTermsEnvelopeSchema>;
export type MandateCommitmentPayload = z.infer<typeof mandateCommitmentPayloadSchema>;
export type SignedMandateCommitment = z.infer<typeof signedMandateCommitmentSchema>;
export type MandateRevocationPayload = z.infer<typeof mandateRevocationPayloadSchema>;
export type SignedMandateRevocation = z.infer<typeof signedMandateRevocationSchema>;
export type MandateUseRequest = z.infer<typeof mandateUseRequestSchema>;

export function signMandate(mandate: UnsignedMandate, signedAt: string, signingSecretKey: string): SignedMandate {
  const parsed = unsignedMandateSchema.parse(mandate);
  const unsigned = { mandate: parsed, signedAt };
  return signedMandateSchema.parse({ ...unsigned, signature: signCanonical(unsigned, signingSecretKey) });
}

export function verifyMandate(value: SignedMandate, signingPublicKey: string): boolean {
  const parsed = signedMandateSchema.safeParse(value);
  if (!parsed.success) return false;
  const { signature, ...unsigned } = parsed.data;
  return verifyCanonical(unsigned, signature, signingPublicKey);
}

export function hashSignedMandate(value: SignedMandate): string {
  return hashCanonical(signedMandateSchema.parse(value));
}

export function signMandateCommitment(
  commitment: MandateCommitmentPayload,
  signingSecretKey: string,
): SignedMandateCommitment {
  const parsed = mandateCommitmentPayloadSchema.parse(commitment);
  return signedMandateCommitmentSchema.parse({
    commitment: parsed,
    signature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyMandateCommitment(value: SignedMandateCommitment, signingPublicKey: string): boolean {
  const parsed = signedMandateCommitmentSchema.safeParse(value);
  return parsed.success && verifyCanonical(parsed.data.commitment, parsed.data.signature, signingPublicKey);
}

export function mandateCommitmentMatchesTerms(
  commitment: SignedMandateCommitment,
  terms: SignedMandate,
): boolean {
  return commitment.commitment.termsHash === hashSignedMandate(terms)
    && commitment.commitment.mandateId === terms.mandate.mandateId
    && commitment.commitment.revision === terms.mandate.revision
    && commitment.commitment.principalPeerId === terms.mandate.principalPeerId
    && commitment.commitment.actorPeerId === terms.mandate.actorPeerId
    && commitment.commitment.issuedByPeerId === terms.mandate.issuedByPeerId
    && commitment.commitment.validFrom === terms.mandate.validFrom
    && commitment.commitment.validUntil === terms.mandate.validUntil
    && commitment.commitment.workroomId === terms.mandate.workroomId;
}

export function mandateCommitmentMatchesEncryptedTerms(
  commitment: SignedMandateCommitment,
  envelope: MandateEncryptedTermsEnvelope,
): boolean {
  const parsedCommitment = signedMandateCommitmentSchema.safeParse(commitment);
  const parsedEnvelope = mandateEncryptedTermsEnvelopeSchema.safeParse(envelope);
  if (!parsedCommitment.success || !parsedEnvelope.success) return false;
  return parsedCommitment.data.commitment.encryptedTermsHash === hashCanonical(parsedEnvelope.data)
    && parsedCommitment.data.commitment.mandateId === parsedEnvelope.data.mandateId
    && parsedCommitment.data.commitment.revision === parsedEnvelope.data.revision
    && parsedCommitment.data.commitment.issuedByPeerId === parsedEnvelope.data.senderPeerId;
}

export function signMandateEncryptedTermsEnvelope(
  value: UnsignedMandateEncryptedTermsEnvelope,
  signingSecretKey: string,
): MandateEncryptedTermsEnvelope {
  const parsed = unsignedMandateEncryptedTermsEnvelopeSchema.parse(value);
  if (hashBase64UrlPayload(parsed.ciphertext) !== parsed.ciphertextHash) {
    throw new Error("MANDATE_CIPHERTEXT_HASH_MISMATCH");
  }
  return mandateEncryptedTermsEnvelopeSchema.parse({
    ...parsed,
    senderSignature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyMandateEncryptedTermsEnvelope(
  value: MandateEncryptedTermsEnvelope,
  signingPublicKey: string,
): boolean {
  const parsed = mandateEncryptedTermsEnvelopeSchema.safeParse(value);
  if (!parsed.success || hashBase64UrlPayload(parsed.data.ciphertext) !== parsed.data.ciphertextHash) return false;
  const { senderSignature, ...unsigned } = parsed.data;
  return verifyCanonical(unsigned, senderSignature, signingPublicKey);
}

export interface EncryptMandateTermsInput {
  envelopeId: string;
  mandateId: string;
  revision: number;
  senderPeerId: string;
  signedMandate: SignedMandate;
  senderSigningSecretKey: string;
  senderEncryptionSecretKey: string;
  recipients: GroupBoxRecipient[];
  createdAt: string;
  randomBytes?: (length: number) => Uint8Array;
}

/** Encrypts the complete signed terms; the relay receives only the commitment. */
export function encryptMandateTerms(input: EncryptMandateTermsInput): MandateEncryptedTermsEnvelope {
  const signedMandate = signedMandateSchema.parse(input.signedMandate);
  if (signedMandate.mandate.mandateId !== input.mandateId || signedMandate.mandate.revision !== input.revision) {
    throw new Error("MANDATE_ENVELOPE_CONTEXT_MISMATCH");
  }
  const sealed = sealGroupBox({
    plaintext: utf8(JSON.stringify(signedMandate)),
    senderEncryptionSecretKey: input.senderEncryptionSecretKey,
    recipients: input.recipients,
    ...(input.randomBytes ? { randomBytes: input.randomBytes } : {}),
  });
  return signMandateEncryptedTermsEnvelope({
    version: 1,
    cipherSuite: "ATALK_GROUP_BOX_V1",
    envelopeId: input.envelopeId,
    mandateId: input.mandateId,
    revision: input.revision,
    senderPeerId: input.senderPeerId,
    ...sealed,
    ciphertextHash: hashBase64UrlPayload(sealed.ciphertext),
    createdAt: input.createdAt,
  }, input.senderSigningSecretKey);
}

export interface DecryptMandateTermsInput {
  envelope: MandateEncryptedTermsEnvelope;
  recipientPeerId: string;
  recipientEncryptionSecretKey: string;
  senderEncryptionPublicKey: string;
  senderSigningPublicKey: string;
}

/** Verifies and opens a signed mandate using the current recipient's wrapped key. */
export function decryptMandateTerms(input: DecryptMandateTermsInput): SignedMandate {
  if (!verifyMandateEncryptedTermsEnvelope(input.envelope, input.senderSigningPublicKey)) {
    throw new Error("INVALID_ENCRYPTED_TERMS");
  }
  const plaintext = openGroupBox({
    nonce: input.envelope.nonce,
    ciphertext: input.envelope.ciphertext,
    wrappedKeys: input.envelope.wrappedKeys,
    recipientPeerId: input.recipientPeerId,
    recipientEncryptionSecretKey: input.recipientEncryptionSecretKey,
    senderEncryptionPublicKey: input.senderEncryptionPublicKey,
  });
  try {
    return signedMandateSchema.parse(JSON.parse(fromUtf8(plaintext)));
  } catch {
    throw new Error("INVALID_MANDATE_TERMS_PAYLOAD");
  }
}

export function signMandateRevocation(
  revocation: MandateRevocationPayload,
  signingSecretKey: string,
): SignedMandateRevocation {
  const parsed = mandateRevocationPayloadSchema.parse(revocation);
  return signedMandateRevocationSchema.parse({
    revocation: parsed,
    signature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyMandateRevocation(value: SignedMandateRevocation, signingPublicKey: string): boolean {
  const parsed = signedMandateRevocationSchema.safeParse(value);
  return parsed.success && verifyCanonical(parsed.data.revocation, parsed.data.signature, signingPublicKey);
}

function exceeds(current: number, delta: number, maximum: number | undefined): boolean {
  return maximum !== undefined && current + delta > maximum;
}

function thresholdMatches(
  threshold: UnsignedMandate["approvalThresholds"][number],
  request: MandateUseRequest,
): boolean {
  const condition = threshold.when;
  if (condition.action !== undefined && condition.action !== request.action) return false;
  if (condition.tool !== undefined && condition.tool !== request.tool?.tool) return false;
  if (condition.amountAboveMinor !== undefined) {
    if (!request.spend
      || request.spend.currency !== condition.currency
      || request.spend.amountMinor <= condition.amountAboveMinor) return false;
  }
  if (condition.dataClassification !== undefined
    && !request.dataAccesses.some(({ classification }) => classification === condition.dataClassification)) return false;
  return true;
}

function toolAudienceAllowed(allowed: string | undefined, requested: string | undefined): boolean {
  if (!allowed) return true;
  if (!requested) return false;
  const requestedHost = audienceHost(requested);
  return allowed.split(/[\s,]+/u).filter(Boolean).some((entry) => {
    if (entry === "*") return true;
    const wildcard = entry.startsWith("*.");
    const allowedHost = audienceHost(wildcard ? entry.slice(2) : entry);
    if (!allowedHost || !requestedHost) return entry.toLowerCase() === requested.toLowerCase();
    return wildcard
      ? requestedHost === allowedHost || requestedHost.endsWith(`.${allowedHost}`)
      : requestedHost === allowedHost;
  });
}

function audienceHost(value: string): string | undefined {
  const candidate = value.trim().toLowerCase();
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate.includes("://") ? candidate : `https://${candidate}`);
    return url.hostname.replace(/\.$/u, "");
  } catch {
    return undefined;
  }
}

/** Deterministically evaluates one proposed use against decrypted signed terms. */
export function evaluateMandateUse(
  mandateValue: UnsignedMandate,
  requestValue: MandateUseRequest,
): MandateUseDecision {
  const mandate = unsignedMandateSchema.parse(mandateValue);
  const request = mandateUseRequestSchema.parse(requestValue);
  if (request.mandateId !== mandate.mandateId || request.revision !== mandate.revision) {
    return { status: "denied", code: "MANDATE_MISMATCH" };
  }
  const evaluatedAt = Date.parse(request.evaluatedAt);
  if (evaluatedAt < Date.parse(mandate.validFrom)) return { status: "denied", code: "MANDATE_NOT_YET_VALID" };
  if (evaluatedAt >= Date.parse(mandate.validUntil)) return { status: "denied", code: "MANDATE_EXPIRED" };
  const knownEndConditions = new Set(mandate.endConditions.map(({ id }) => id));
  const deadlineEnded = mandate.endConditions.some((condition) =>
    condition.type === "deadline" && evaluatedAt >= Date.parse(condition.at));
  if (deadlineEnded || request.metEndConditionIds.some((id) => knownEndConditions.has(id))) {
    return { status: "denied", code: "MANDATE_ENDED" };
  }

  if (request.actingPeerId !== mandate.actorPeerId) {
    if (!mandate.delegation.allowed
      || !mandate.delegation.allowedDelegatePeerIds.includes(request.actingPeerId)) {
      return { status: "denied", code: "DELEGATION_DENIED" };
    }
    if (request.delegationDepth < 1 || request.delegationDepth > mandate.delegation.maxDepth) {
      return { status: "denied", code: "DELEGATION_DEPTH_EXCEEDED" };
    }
    if (mandate.delegation.requirePrincipalApproval && !request.principalApprovedDelegation) {
      return { status: "requires_approval", thresholdIds: [], reason: "DELEGATION" };
    }
  } else if (request.delegationDepth !== 0) {
    return { status: "denied", code: "DELEGATION_DEPTH_EXCEEDED" };
  }

  const allowedParticipants = new Set(mandate.allowedParticipantPeerIds);
  if (request.participantPeerIds.some((peerId) => !allowedParticipants.has(peerId))) {
    return { status: "denied", code: "PARTICIPANT_DENIED" };
  }
  if (!mandate.allowedActions.includes(request.action)) return { status: "denied", code: "ACTION_DENIED" };
  if (request.tool) {
    const grant = mandate.allowedTools.find(({ tool }) => tool === request.tool?.tool);
    if (!grant?.actions.includes(request.tool.action)
      || !toolAudienceAllowed(grant.audience, request.tool.audience)) {
      return { status: "denied", code: "TOOL_DENIED" };
    }
  }
  for (const access of request.dataAccesses) {
    const grant = mandate.allowedData.find(({ resource }) => resource === access.resource);
    if (!grant?.permissions.includes(access.permission)) return { status: "denied", code: "DATA_DENIED", detail: access.resource };
    if (access.recipientPeerIds.some((peerId) => !grant.allowedRecipientPeerIds.includes(peerId))) {
      return { status: "denied", code: "DATA_DENIED", detail: access.resource };
    }
  }
  if (request.spend) {
    const limits = mandate.spendLimits.filter(({ currency }) => currency === request.spend?.currency);
    if (limits.length === 0) return { status: "denied", code: "SPEND_LIMIT_EXCEEDED" };
    for (const limit of limits) {
      if (limit.maximumPerOperationMinor !== undefined
        && request.spend.amountMinor > limit.maximumPerOperationMinor) {
        return { status: "denied", code: "SPEND_LIMIT_EXCEEDED", detail: `${limit.currency}:operation` };
      }
      const used = request.spendUsedMinorByLimit[`${limit.currency}:${limit.period}`] ?? 0;
      if (used + request.spend.amountMinor > limit.maximumAmountMinor) {
        return { status: "denied", code: "SPEND_LIMIT_EXCEEDED", detail: `${limit.currency}:${limit.period}` };
      }
    }
  }
  const volume = mandate.volumeLimits;
  if (volume) {
    if (exceeds(request.volumeUsed.messages, request.volumeDelta.messages, volume.maxMessages)
      || exceeds(request.volumeUsed.files, request.volumeDelta.files, volume.maxFiles)
      || exceeds(request.volumeUsed.totalBytes, request.volumeDelta.totalBytes, volume.maxTotalBytes)
      || exceeds(request.volumeUsed.actions, request.volumeDelta.actions, volume.maxActions)) {
      return { status: "denied", code: "VOLUME_LIMIT_EXCEEDED" };
    }
    for (const [metric, maximum] of Object.entries(volume.custom)) {
      if (exceeds(request.volumeUsed.custom[metric] ?? 0, request.volumeDelta.custom[metric] ?? 0, maximum)) {
        return { status: "denied", code: "VOLUME_LIMIT_EXCEEDED", detail: metric };
      }
    }
  }

  const missingThresholds = mandate.approvalThresholds.filter((threshold) => {
    if (!thresholdMatches(threshold, request)) return false;
    const evidence = request.verifiedApprovals.find(({ thresholdId }) => thresholdId === threshold.id);
    if (!evidence) return true;
    const eligible = new Set(threshold.approverPeerIds);
    const uniqueApproved = new Set(evidence.approverPeerIds.filter((peerId) => eligible.has(peerId)));
    return uniqueApproved.size < threshold.requiredApprovals;
  });
  if (missingThresholds.length > 0) {
    return { status: "requires_approval", thresholdIds: missingThresholds.map(({ id }) => id), reason: "THRESHOLD" };
  }
  return { status: "permitted" };
}
