import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { decryptText, encryptText } from "./crypto.js";
import { toBase64Url } from "./encoding.js";

const senderSigning = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
const senderEncryption = nacl.box.keyPair.fromSecretKey(
  Uint8Array.from({ length: 32 }, (_, index) => index + 33),
);
const recipientEncryption = nacl.box.keyPair.fromSecretKey(
  Uint8Array.from({ length: 32 }, (_, index) => index + 65),
);

describe("protocol crypto", () => {
  it("encrypts, signs, verifies and decrypts a deterministic text envelope", () => {
    const envelope = encryptText({
      messageId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      senderPeerId: "33333333-3333-4333-8333-333333333333",
      recipientPeerId: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-08-28T12:00:00.000Z",
      plaintext: "Hola desde aTalk",
      senderSigningSecretKey: toBase64Url(senderSigning.secretKey),
      senderEncryptionSecretKey: toBase64Url(senderEncryption.secretKey),
      recipientEncryptionPublicKey: toBase64Url(recipientEncryption.publicKey),
      nonce: Uint8Array.from({ length: 24 }, (_, index) => index + 1),
    });

    expect(
      decryptText({
        envelope,
        senderSigningPublicKey: toBase64Url(senderSigning.publicKey),
        senderEncryptionPublicKey: toBase64Url(senderEncryption.publicKey),
        recipientEncryptionSecretKey: toBase64Url(recipientEncryption.secretKey),
      }),
    ).toBe("Hola desde aTalk");
  });

  it("rejects envelope tampering", () => {
    const envelope = encryptText({
      messageId: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      senderPeerId: "33333333-3333-4333-8333-333333333333",
      recipientPeerId: "44444444-4444-4444-8444-444444444444",
      timestamp: "2026-08-28T12:00:00.000Z",
      plaintext: "original",
      senderSigningSecretKey: toBase64Url(senderSigning.secretKey),
      senderEncryptionSecretKey: toBase64Url(senderEncryption.secretKey),
      recipientEncryptionPublicKey: toBase64Url(recipientEncryption.publicKey),
      nonce: new Uint8Array(24).fill(9),
    });

    expect(() =>
      decryptText({
        envelope: { ...envelope, recipient_peer_id: "55555555-5555-4555-8555-555555555555" },
        senderSigningPublicKey: toBase64Url(senderSigning.publicKey),
        senderEncryptionPublicKey: toBase64Url(senderEncryption.publicKey),
        recipientEncryptionSecretKey: toBase64Url(recipientEncryption.secretKey),
      }),
    ).toThrow("INVALID_SIGNATURE");
  });
});
