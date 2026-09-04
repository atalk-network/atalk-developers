import nacl from "tweetnacl";
import { z } from "zod";

import { fromBase64Url, toBase64Url } from "./encoding.js";

export const ATTACHMENT_MESSAGE_PREFIX = "__ATALK_ATTACHMENT_V1__";
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Maximum accepted legacy/server part size. Kept stable for v1 compatibility. */
export const ATTACHMENT_CHUNK_BYTES = 8 * 1024 * 1024;
/** Smaller v2 chunks keep UI cancellation responsive and make retries cheap. */
export const ATTACHMENT_PLAINTEXT_CHUNK_BYTES = 2 * 1024 * 1024;

const base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/u).max(256);

const attachmentChunkSchema = z.object({
  id: z.uuid(),
  ciphertextSize: z.number().int().positive().max(ATTACHMENT_CHUNK_BYTES),
}).strict();

const attachmentChunkV2Schema = attachmentChunkSchema.extend({
  plaintextSize: z.number().int().positive().max(ATTACHMENT_PLAINTEXT_CHUNK_BYTES),
  nonce: base64Url,
}).strict();

const attachmentDescriptorV1Schema = z.object({
  version: z.literal(1),
  id: z.uuid(),
  kind: z.enum(["IMAGE", "VIDEO", "FILE"] as const),
  name: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(160),
  size: z.number().int().nonnegative().max(MAX_ATTACHMENT_BYTES),
  ciphertextSize: z.number().int().positive().max(MAX_ATTACHMENT_BYTES + nacl.secretbox.overheadLength),
  key: base64Url,
  nonce: base64Url,
  chunks: z.array(attachmentChunkSchema)
    .min(2)
    .max(Math.ceil((MAX_ATTACHMENT_BYTES + nacl.secretbox.overheadLength) / ATTACHMENT_CHUNK_BYTES))
    .optional(),
}).strict().superRefine((descriptor, context) => {
  if (!descriptor.chunks) return;
  if (descriptor.chunks[0]?.id !== descriptor.id) {
    context.addIssue({ code: "custom", path: ["chunks", 0, "id"], message: "First chunk must use the attachment id" });
  }
  if (new Set(descriptor.chunks.map((chunk) => chunk.id)).size !== descriptor.chunks.length) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Chunk ids must be unique" });
  }
  const total = descriptor.chunks.reduce((sum, chunk) => sum + chunk.ciphertextSize, 0);
  if (total !== descriptor.ciphertextSize) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Chunk sizes must equal ciphertext size" });
  }
});

const attachmentDescriptorV2Schema = z.object({
  version: z.literal(2),
  id: z.uuid(),
  kind: z.enum(["IMAGE", "VIDEO", "FILE"] as const),
  name: z.string().trim().min(1).max(180),
  mimeType: z.string().trim().min(1).max(160),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  ciphertextSize: z.number().int().positive().max(
    MAX_ATTACHMENT_BYTES + Math.ceil(MAX_ATTACHMENT_BYTES / ATTACHMENT_PLAINTEXT_CHUNK_BYTES) * nacl.secretbox.overheadLength,
  ),
  key: base64Url,
  chunks: z.array(attachmentChunkV2Schema)
    .min(1)
    .max(Math.ceil(MAX_ATTACHMENT_BYTES / ATTACHMENT_PLAINTEXT_CHUNK_BYTES)),
}).strict().superRefine((descriptor, context) => {
  if (descriptor.chunks[0]?.id !== descriptor.id) {
    context.addIssue({ code: "custom", path: ["chunks", 0, "id"], message: "First chunk must use the attachment id" });
  }
  if (new Set(descriptor.chunks.map((chunk) => chunk.id)).size !== descriptor.chunks.length) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Chunk ids must be unique" });
  }
  if (descriptor.chunks.reduce((sum, chunk) => sum + chunk.plaintextSize, 0) !== descriptor.size) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Chunk plaintext sizes must equal attachment size" });
  }
  if (descriptor.chunks.reduce((sum, chunk) => sum + chunk.ciphertextSize, 0) !== descriptor.ciphertextSize) {
    context.addIssue({ code: "custom", path: ["chunks"], message: "Chunk ciphertext sizes must equal ciphertext size" });
  }
  descriptor.chunks.forEach((chunk, index) => {
    if (chunk.ciphertextSize !== chunk.plaintextSize + nacl.secretbox.overheadLength) {
      context.addIssue({ code: "custom", path: ["chunks", index, "ciphertextSize"], message: "Invalid encrypted chunk size" });
    }
  });
});

export const attachmentDescriptorSchema = z.discriminatedUnion("version", [
  attachmentDescriptorV1Schema,
  attachmentDescriptorV2Schema,
]);

export type AttachmentDescriptor = z.infer<typeof attachmentDescriptorSchema>;

const attachmentMessageSchema = z.object({
  attachment: attachmentDescriptorSchema,
  caption: z.string().trim().max(4_000).optional(),
}).strict();

export interface AttachmentMessage {
  attachment: AttachmentDescriptor;
  caption?: string;
}

export interface EncryptAttachmentInput {
  id: string;
  bytes: Uint8Array;
  name: string;
  mimeType: string;
  kind?: AttachmentDescriptor["kind"];
  key?: Uint8Array;
  nonce?: Uint8Array;
}

export interface EncryptedAttachmentPart {
  id: string;
  ciphertext: Uint8Array;
}

export interface CreateChunkedAttachmentInput {
  id: string;
  size: number;
  name: string;
  mimeType: string;
  kind?: AttachmentDescriptor["kind"];
  key?: Uint8Array;
  nextId: () => string;
  nextNonce?: () => Uint8Array;
}

/** Build a v2 descriptor whose chunks are independently authenticated and can be retried/resumed. */
export function createChunkedAttachmentDescriptor(input: CreateChunkedAttachmentInput): AttachmentDescriptor {
  if (input.size <= 0) throw new Error("ATTACHMENT_EMPTY");
  if (input.size > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  const key = input.key ?? nacl.randomBytes(nacl.secretbox.keyLength);
  if (key.byteLength !== nacl.secretbox.keyLength) throw new Error("INVALID_ATTACHMENT_KEY_LENGTH");
  const chunks = [];
  for (let offset = 0; offset < input.size; offset += ATTACHMENT_PLAINTEXT_CHUNK_BYTES) {
    const plaintextSize = Math.min(ATTACHMENT_PLAINTEXT_CHUNK_BYTES, input.size - offset);
    const nonce = input.nextNonce?.() ?? nacl.randomBytes(nacl.secretbox.nonceLength);
    if (nonce.byteLength !== nacl.secretbox.nonceLength) throw new Error("INVALID_ATTACHMENT_NONCE_LENGTH");
    chunks.push({
      id: chunks.length === 0 ? input.id : input.nextId(),
      plaintextSize,
      ciphertextSize: plaintextSize + nacl.secretbox.overheadLength,
      nonce: toBase64Url(nonce),
    });
  }
  return attachmentDescriptorSchema.parse({
    version: 2,
    id: input.id,
    kind: input.kind ?? attachmentKind(input.mimeType),
    name: input.name,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.size,
    ciphertextSize: chunks.reduce((sum, chunk) => sum + chunk.ciphertextSize, 0),
    key: toBase64Url(key),
    chunks,
  });
}

export function encryptAttachmentChunk(
  plaintext: Uint8Array,
  descriptor: AttachmentDescriptor,
  index: number,
): Uint8Array {
  const parsed = attachmentDescriptorSchema.parse(descriptor);
  if (parsed.version !== 2) throw new Error("ATTACHMENT_VERSION_UNSUPPORTED");
  const chunk = parsed.chunks[index];
  if (!chunk || plaintext.byteLength !== chunk.plaintextSize) throw new Error("ATTACHMENT_SIZE_MISMATCH");
  return nacl.secretbox(plaintext, fromBase64Url(chunk.nonce), fromBase64Url(parsed.key));
}

export function decryptAttachmentChunk(
  ciphertext: Uint8Array,
  descriptor: AttachmentDescriptor,
  index: number,
): Uint8Array {
  const parsed = attachmentDescriptorSchema.parse(descriptor);
  if (parsed.version !== 2) throw new Error("ATTACHMENT_VERSION_UNSUPPORTED");
  const chunk = parsed.chunks[index];
  if (!chunk || ciphertext.byteLength !== chunk.ciphertextSize) throw new Error("ATTACHMENT_SIZE_MISMATCH");
  const plaintext = nacl.secretbox.open(ciphertext, fromBase64Url(chunk.nonce), fromBase64Url(parsed.key));
  if (!plaintext || plaintext.byteLength !== chunk.plaintextSize) throw new Error("ATTACHMENT_DECRYPTION_FAILED");
  return plaintext;
}

export function encryptAttachment(input: EncryptAttachmentInput): {
  descriptor: AttachmentDescriptor;
  ciphertext: Uint8Array;
} {
  if (input.bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
  const key = input.key ?? nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = input.nonce ?? nacl.randomBytes(nacl.secretbox.nonceLength);
  if (key.byteLength !== nacl.secretbox.keyLength) throw new Error("INVALID_ATTACHMENT_KEY_LENGTH");
  if (nonce.byteLength !== nacl.secretbox.nonceLength) throw new Error("INVALID_ATTACHMENT_NONCE_LENGTH");
  const ciphertext = nacl.secretbox(input.bytes, nonce, key);
  const descriptor = attachmentDescriptorSchema.parse({
    version: 1,
    id: input.id,
    kind: input.kind ?? attachmentKind(input.mimeType),
    name: input.name,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.bytes.byteLength,
    ciphertextSize: ciphertext.byteLength,
    key: toBase64Url(key),
    nonce: toBase64Url(nonce),
  });
  return { descriptor, ciphertext };
}

export function decryptAttachment(ciphertext: Uint8Array, descriptor: AttachmentDescriptor): Uint8Array {
  const parsed = attachmentDescriptorSchema.parse(descriptor);
  if (ciphertext.byteLength !== parsed.ciphertextSize) throw new Error("ATTACHMENT_SIZE_MISMATCH");
  if (parsed.version === 2) {
    const plaintext = new Uint8Array(parsed.size);
    let cipherOffset = 0;
    let plainOffset = 0;
    parsed.chunks.forEach((chunk, index) => {
      const opened = decryptAttachmentChunk(
        ciphertext.slice(cipherOffset, cipherOffset + chunk.ciphertextSize),
        parsed,
        index,
      );
      plaintext.set(opened, plainOffset);
      cipherOffset += chunk.ciphertextSize;
      plainOffset += opened.byteLength;
    });
    return plaintext;
  }
  const plaintext = nacl.secretbox.open(
    ciphertext,
    fromBase64Url(parsed.nonce),
    fromBase64Url(parsed.key),
  );
  if (!plaintext || plaintext.byteLength !== parsed.size) throw new Error("ATTACHMENT_DECRYPTION_FAILED");
  return plaintext;
}

export function splitEncryptedAttachment(
  encrypted: { descriptor: AttachmentDescriptor; ciphertext: Uint8Array },
  nextId: () => string,
): { descriptor: AttachmentDescriptor; parts: EncryptedAttachmentPart[] } {
  const parts: EncryptedAttachmentPart[] = [];
  for (let offset = 0; offset < encrypted.ciphertext.byteLength; offset += ATTACHMENT_CHUNK_BYTES) {
    parts.push({
      id: parts.length === 0 ? encrypted.descriptor.id : nextId(),
      ciphertext: encrypted.ciphertext.slice(offset, Math.min(offset + ATTACHMENT_CHUNK_BYTES, encrypted.ciphertext.byteLength)),
    });
  }
  if (parts.length <= 1) return { descriptor: encrypted.descriptor, parts };
  const descriptor = attachmentDescriptorSchema.parse({
    ...encrypted.descriptor,
    chunks: parts.map((part) => ({ id: part.id, ciphertextSize: part.ciphertext.byteLength })),
  });
  return { descriptor, parts };
}

export function joinEncryptedAttachmentParts(
  parts: Uint8Array[],
  descriptor: AttachmentDescriptor,
): Uint8Array {
  const expected = descriptor.chunks
    ?? [{ id: descriptor.id, ciphertextSize: descriptor.ciphertextSize }];
  if (parts.length !== expected.length) throw new Error("ATTACHMENT_PARTS_MISSING");
  const joined = new Uint8Array(descriptor.ciphertextSize);
  let offset = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const part = parts[index];
    const metadata = expected[index];
    if (!part || !metadata || part.byteLength !== metadata.ciphertextSize) {
      throw new Error("ATTACHMENT_SIZE_MISMATCH");
    }
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

export function attachmentPartDescriptors(
  descriptor: AttachmentDescriptor,
): Array<{ id: string; ciphertextSize: number; plaintextSize?: number; nonce?: string }> {
  return descriptor.chunks ?? [{ id: descriptor.id, ciphertextSize: descriptor.ciphertextSize }];
}

export function encodeAttachmentMessage(message: AttachmentMessage): string {
  const parsed = attachmentMessageSchema.parse(message);
  return `${ATTACHMENT_MESSAGE_PREFIX}${JSON.stringify(parsed)}`;
}

export function decodeAttachmentMessage(value: string): AttachmentMessage | undefined {
  if (!value.startsWith(ATTACHMENT_MESSAGE_PREFIX)) return undefined;
  const parsed = attachmentMessageSchema.parse(JSON.parse(value.slice(ATTACHMENT_MESSAGE_PREFIX.length)));
  return {
    attachment: parsed.attachment,
    ...(parsed.caption !== undefined ? { caption: parsed.caption } : {}),
  };
}

export function attachmentKind(mimeType: string): AttachmentDescriptor["kind"] {
  if (mimeType.toLowerCase().startsWith("image/")) return "IMAGE";
  if (mimeType.toLowerCase().startsWith("video/")) return "VIDEO";
  return "FILE";
}
