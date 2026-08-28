import { z } from "zod";
import { MESSAGE_STATES, PEER_STATUSES, PEER_TYPES } from "./types.js";

const uuid = z.uuid();
const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(200_000);

export const publicPeerSchema = z
  .object({
    id: uuid,
    type: z.enum(PEER_TYPES),
    status: z.enum(PEER_STATUSES),
    handle: z.string().regex(/^@[a-z0-9][a-z0-9._-]{1,62}$/u),
    displayName: z.string().trim().min(1).max(120),
    signingPublicKey: base64Url,
    encryptionPublicKey: base64Url,
    organizationId: uuid.optional(),
    ownerPeerId: uuid.optional(),
    membershipOrganizationIds: z.array(uuid).optional(),
  })
  .strict();

export const unsignedEnvelopeSchema = z
  .object({
    version: z.literal(1),
    message_id: uuid,
    conversation_id: uuid,
    sender_peer_id: uuid,
    recipient_peer_id: uuid,
    timestamp: z.iso.datetime({ offset: true }),
    type: z.literal("TEXT"),
    nonce: base64Url,
    ciphertext: base64Url,
  })
  .strict();

export const envelopeSchema = unsignedEnvelopeSchema
  .extend({ signature: base64Url })
  .strict();

export type UnsignedEnvelope = z.infer<typeof unsignedEnvelopeSchema>;
export type EncryptedEnvelope = z.infer<typeof envelopeSchema>;

export const clientFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("AUTH"), token: z.string().min(32).max(512) }).strict(),
  z.object({ kind: z.literal("DELIVER"), envelope: envelopeSchema }).strict(),
  z
    .object({
      kind: z.literal("ACK"),
      messageId: uuid,
      state: z.enum(["DELIVERED", "READ"] as const),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RECEIPT_ACK"),
      messageId: uuid,
      state: z.enum(MESSAGE_STATES),
    })
    .strict(),
  z.object({ kind: z.literal("PING") }).strict(),
]);

export const serverFrameSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("READY"), peer: publicPeerSchema, serverTime: z.iso.datetime({ offset: true }) })
    .strict(),
  z.object({ kind: z.literal("MESSAGE"), envelope: envelopeSchema }).strict(),
  z
    .object({ kind: z.literal("RECEIPT"), messageId: uuid, state: z.enum(MESSAGE_STATES) })
    .strict(),
  z
    .object({ kind: z.literal("ACK_RECEIVED"), messageId: uuid, state: z.enum(["DELIVERED", "READ"] as const) })
    .strict(),
  z
    .object({
      kind: z.literal("PRESENCE"),
      peerId: uuid,
      state: z.enum(["ONLINE", "OFFLINE", "UNKNOWN"] as const),
    })
    .strict(),
  z
    .object({
      kind: z.literal("ERROR"),
      code: z.string().max(80),
      message: z.string().max(240),
      messageId: uuid.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("PONG") }).strict(),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;
export type ServerFrame = z.infer<typeof serverFrameSchema>;
