import { describe, expect, it } from "vitest";

import {
  decodeAttachmentMessage,
  decryptAttachment,
  encodeAttachmentMessage,
  encryptAttachment,
  joinEncryptedAttachmentParts,
  splitEncryptedAttachment,
} from "./attachments.js";
import { utf8, fromUtf8 } from "./encoding.js";

describe("encrypted attachments", () => {
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
