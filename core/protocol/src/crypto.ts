import nacl from "tweetnacl";
import { canonicalBytes, fromBase64Url, fromUtf8, toBase64Url, utf8 } from "./encoding.js";
import { envelopeSchema, type EncryptedEnvelope, type UnsignedEnvelope } from "./schema.js";
import type { IdentityKeyPair } from "./types.js";

export function generateIdentityKeys(): IdentityKeyPair {
  const signing = nacl.sign.keyPair();
  const encryption = nacl.box.keyPair();
  return {
    signingPublicKey: toBase64Url(signing.publicKey),
    signingSecretKey: toBase64Url(signing.secretKey),
    encryptionPublicKey: toBase64Url(encryption.publicKey),
    encryptionSecretKey: toBase64Url(encryption.secretKey),
  };
}

export interface EncryptTextInput {
  messageId: string;
  conversationId: string;
  senderPeerId: string;
  recipientPeerId: string;
  timestamp: string;
  plaintext: string;
  senderSigningSecretKey: string;
  senderEncryptionSecretKey: string;
  recipientEncryptionPublicKey: string;
  nonce?: Uint8Array;
}

export function encryptText(input: EncryptTextInput): EncryptedEnvelope {
  const nonce = input.nonce ?? nacl.randomBytes(nacl.box.nonceLength);
  if (nonce.length !== nacl.box.nonceLength) throw new Error("INVALID_NONCE_LENGTH");

  const ciphertext = nacl.box(
    utf8(input.plaintext),
    nonce,
    fromBase64Url(input.recipientEncryptionPublicKey),
    fromBase64Url(input.senderEncryptionSecretKey),
  );

  const unsigned: UnsignedEnvelope = {
    version: 1,
    message_id: input.messageId,
    conversation_id: input.conversationId,
    sender_peer_id: input.senderPeerId,
    recipient_peer_id: input.recipientPeerId,
    timestamp: input.timestamp,
    type: "TEXT",
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(ciphertext),
  };

  const signature = nacl.sign.detached(
    canonicalBytes(unsigned),
    fromBase64Url(input.senderSigningSecretKey),
  );
  return envelopeSchema.parse({ ...unsigned, signature: toBase64Url(signature) });
}

export function verifyEnvelope(envelope: EncryptedEnvelope, senderSigningPublicKey: string): boolean {
  const parsed = envelopeSchema.parse(envelope);
  const { signature, ...unsigned } = parsed;
  return nacl.sign.detached.verify(
    canonicalBytes(unsigned),
    fromBase64Url(signature),
    fromBase64Url(senderSigningPublicKey),
  );
}

export interface DecryptTextInput {
  envelope: EncryptedEnvelope;
  senderSigningPublicKey: string;
  senderEncryptionPublicKey: string;
  recipientEncryptionSecretKey: string;
}

export function decryptText(input: DecryptTextInput): string {
  if (!verifyEnvelope(input.envelope, input.senderSigningPublicKey)) {
    throw new Error("INVALID_SIGNATURE");
  }

  const plaintext = nacl.box.open(
    fromBase64Url(input.envelope.ciphertext),
    fromBase64Url(input.envelope.nonce),
    fromBase64Url(input.senderEncryptionPublicKey),
    fromBase64Url(input.recipientEncryptionSecretKey),
  );
  if (!plaintext) throw new Error("DECRYPTION_FAILED");
  return fromUtf8(plaintext);
}
