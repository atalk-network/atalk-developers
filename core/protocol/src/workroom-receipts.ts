import { z } from "zod";
import { hashCanonical, signCanonical, verifyCanonical } from "./signatures.js";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(4_096);

export const WORKROOM_RECEIPT_EVENTS = [
  "workroom_created",
  "member_added",
  "member_removed",
  "member_role_changed",
  "ownership_transferred",
  "status_changed",
  "thread_created",
  "event_appended",
  "plan_versioned",
  "artifact_versioned",
  "deliverable_submitted",
  "cost_recorded",
  "approval_requested",
  "approval_decided",
  "mandate_registered",
  "mandate_revoked",
] as const;

export const workroomReceiptPayloadSchema = z.object({
  version: z.literal(1),
  receiptId: uuid,
  workroomId: uuid,
  actorPeerId: uuid,
  signingPublicKey: base64Url,
  event: z.enum(WORKROOM_RECEIPT_EVENTS),
  subjectId: uuid.optional(),
  idempotencyKey: z.string().trim().min(8).max(160),
  payloadHash: base64Url,
  previousReceiptHash: base64Url.nullable(),
  outcome: z.enum(["accepted", "rejected", "recorded"] as const),
  occurredAt: instant,
}).strict();

export const signedWorkroomReceiptSchema = z.object({
  receipt: workroomReceiptPayloadSchema,
  signature: base64Url,
}).strict();

export type WorkroomReceiptPayload = z.infer<typeof workroomReceiptPayloadSchema>;
export type SignedWorkroomReceipt = z.infer<typeof signedWorkroomReceiptSchema>;

export function signWorkroomReceipt(
  receipt: WorkroomReceiptPayload,
  signingSecretKey: string,
): SignedWorkroomReceipt {
  const parsed = workroomReceiptPayloadSchema.parse(receipt);
  return signedWorkroomReceiptSchema.parse({
    receipt: parsed,
    signature: signCanonical(parsed, signingSecretKey),
  });
}

export function verifyWorkroomReceipt(value: SignedWorkroomReceipt, signingPublicKey: string): boolean {
  const parsed = signedWorkroomReceiptSchema.safeParse(value);
  return parsed.success && verifyCanonical(parsed.data.receipt, parsed.data.signature, signingPublicKey);
}

export function hashWorkroomReceipt(value: SignedWorkroomReceipt): string {
  return hashCanonical(signedWorkroomReceiptSchema.parse(value));
}

export function verifyReceiptChain(receipts: readonly SignedWorkroomReceipt[]): boolean {
  let previousHash: string | null = null;
  for (const receipt of receipts) {
    const parsed = signedWorkroomReceiptSchema.safeParse(receipt);
    if (
      !parsed.success
      || parsed.data.receipt.previousReceiptHash !== previousHash
      || !verifyWorkroomReceipt(parsed.data, parsed.data.receipt.signingPublicKey)
    ) return false;
    previousHash = hashWorkroomReceipt(parsed.data);
  }
  return true;
}
