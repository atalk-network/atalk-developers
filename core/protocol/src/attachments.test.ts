import { describe, expect, it } from "vitest";

import {
  createChunkedAttachmentDescriptor,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_PLAINTEXT_CHUNK_BYTES,
  decodeAttachmentMessage,
  decryptAttachment,
  encodeAttachmentMessage,
  encryptAttachment,
  encryptAttachmentChunk,
  decryptAttachmentChunk,
  joinEncryptedAttachmentParts,
  splitEncryptedAttachment,
} from "./attachments.js";
import { utf8, fromUtf8 } from "./encoding.js";

describe("encrypted attachments", () => {
  it("encrypts v2 chunks independently for resumable transfers", () => {
    let id = 1;
    const descriptor = createChunkedAttachmentDescriptor({
      id: "00000000-0000-4000-8000-000000000001",
      size: 3,
      name: "video.mp4",
      mimeType: "video/mp4",
      nextId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      nextNonce: () => new Uint8Array(24).fill(++id),
    });
    if (descriptor.version !== 2) throw new Error("Expected v2 descriptor");
    const first = new Uint8Array(descriptor.chunks[0]!.plaintextSize).fill(7);
    const encrypted = [encryptAttachmentChunk(first, descriptor, 0)];
    expect(decryptAttachmentChunk(encrypted[0]!, descriptor, 0)).toEqual(first);
    encrypted[0]![0] ^= 1;
    expect(() => decryptAttachmentChunk(encrypted[0]!, descriptor, 0)).toThrow("ATTACHMENT_DECRYPTION_FAILED");
  });

  it("describes the 100 MB limit with bounded retry-friendly chunks without allocating the payload", () => {
    let id = 100;
    const descriptor = createChunkedAttachmentDescriptor({
      id: "00000000-0000-4000-8000-000000000100",
      size: MAX_ATTACHMENT_BYTES,
      name: "archive.zip",
      mimeType: "application/zip",
      nextId: () => `00000000-0000-4000-8000-${String(++id).padStart(12, "0")}`,
      nextNonce: () => new Uint8Array(24).fill(id % 255),
    });
    if (descriptor.version !== 2) throw new Error("Expected v2 descriptor");
    expect(descriptor.chunks).toHaveLength(Math.ceil(MAX_ATTACHMENT_BYTES / ATTACHMENT_PLAINTEXT_CHUNK_BYTES));
    expect(Math.max(...descriptor.chunks.map((chunk) => chunk.plaintextSize))).toBe(ATTACHMENT_PLAINTEXT_CHUNK_BYTES);
  });

  it("encrypts the bytes and keeps the decryption material inside the E2EE message", () => {
    const encrypted = encryptAttachment({
      id: "11111111-1111-4111-8111-111111111111",
      bytes: utf8("invoice contents"),
      name: "invoice.pdf",
      mimeType: "application/pdf",
      key: new Uint8Array(32).fill(7),
      nonce: new Uint8Array(24).fill(9),
    });
    expect(fromUtf8(encrypted.ciphertext)).not.toContain("invoice contents");
    const encoded = encodeAttachmentMessage({ attachment: encrypted.descriptor, caption: "August invoice" });
    const decoded = decodeAttachmentMessage(encoded);
    expect(decoded).toMatchObject({ attachment: { kind: "FILE", name: "invoice.pdf" }, caption: "August invoice" });
    expect(fromUtf8(decryptAttachment(encrypted.ciphertext, encrypted.descriptor))).toBe("invoice contents");
  });

  it("rejects tampered attachment ciphertext", () => {
    const encrypted = encryptAttachment({
      id: "22222222-2222-4222-8222-222222222222",
      bytes: utf8("photo"),
      name: "photo.jpg",
      mimeType: "image/jpeg",
    });
    encrypted.ciphertext[0] = (encrypted.ciphertext[0] ?? 0) ^ 1;
    expect(() => decryptAttachment(encrypted.ciphertext, encrypted.descriptor)).toThrow("ATTACHMENT_DECRYPTION_FAILED");
  });

  it("splits large ciphertext into independently transportable opaque parts", () => {
    let next = 2;
    const seed = encryptAttachment({
      id: "33333333-3333-4333-8333-333333333331",
      bytes: new Uint8Array([42]),
      name: "clip.mp4",
      mimeType: "video/mp4",
    });
    const ciphertext = new Uint8Array(9 * 1024 * 1024 + 16).fill(42);
    const encrypted = {
      descriptor: { ...seed.descriptor, size: 9 * 1024 * 1024, ciphertextSize: ciphertext.byteLength },
      ciphertext,
    };
    const split = splitEncryptedAttachment(encrypted, () =>
      `33333333-3333-4333-8333-${String(next++).padStart(12, "0")}`,
    );
    expect(split.parts).toHaveLength(2);
    expect(split.descriptor.chunks?.map((chunk) => chunk.ciphertextSize)).toEqual([
      8 * 1024 * 1024,
      1 * 1024 * 1024 + 16,
    ]);
    const joined = joinEncryptedAttachmentParts(split.parts.map((part) => part.ciphertext), split.descriptor);
    expect(joined.byteLength).toBe(ciphertext.byteLength);
    expect([joined[0], joined[8 * 1024 * 1024], joined.at(-1)]).toEqual([42, 42, 42]);
  });
});
