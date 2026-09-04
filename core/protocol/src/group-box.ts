import nacl from "tweetnacl";

import { fromBase64Url, toBase64Url } from "./encoding.js";

export interface GroupBoxRecipient {
  peerId: string;
  encryptionPublicKey: string;
}

export interface GroupBoxWrappedKey {
  recipientPeerId: string;
  nonce: string;
  ciphertext: string;
}

export interface GroupBoxCiphertext {
  nonce: string;
  ciphertext: string;
  wrappedKeys: GroupBoxWrappedKey[];
}

export interface SealGroupBoxInput {
  plaintext: Uint8Array;
  senderEncryptionSecretKey: string;
  recipients: GroupBoxRecipient[];
  randomBytes?: (length: number) => Uint8Array;
}

/**
 * Encrypt one payload under a random content key and wrap that key once for
 * every recipient. The caller signs the surrounding context-specific envelope.
 */
export function sealGroupBox(input: SealGroupBoxInput): GroupBoxCiphertext {
  const recipients = uniqueRecipients(input.recipients);
  if (recipients.length === 0) throw new Error("GROUP_BOX_RECIPIENT_REQUIRED");
  const randomBytes = input.randomBytes ?? nacl.randomBytes;
  const contentKey = randomBytes(nacl.secretbox.keyLength);
  if (contentKey.byteLength !== nacl.secretbox.keyLength) throw new Error("INVALID_GROUP_KEY_LENGTH");
  const nonce = randomBytes(nacl.secretbox.nonceLength);
  if (nonce.byteLength !== nacl.secretbox.nonceLength) throw new Error("INVALID_GROUP_NONCE_LENGTH");
  const senderSecretKey = fromBase64Url(input.senderEncryptionSecretKey);
  if (senderSecretKey.byteLength !== nacl.box.secretKeyLength) throw new Error("INVALID_ENCRYPTION_SECRET_KEY");

  return {
    nonce: toBase64Url(nonce),
    ciphertext: toBase64Url(nacl.secretbox(input.plaintext, nonce, contentKey)),
    wrappedKeys: recipients.map((recipient) => {
      const wrapNonce = randomBytes(nacl.box.nonceLength);
      if (wrapNonce.byteLength !== nacl.box.nonceLength) throw new Error("INVALID_GROUP_WRAP_NONCE_LENGTH");
      const recipientPublicKey = fromBase64Url(recipient.encryptionPublicKey);
      if (recipientPublicKey.byteLength !== nacl.box.publicKeyLength) throw new Error("INVALID_ENCRYPTION_PUBLIC_KEY");
      return {
        recipientPeerId: recipient.peerId,
        nonce: toBase64Url(wrapNonce),
        ciphertext: toBase64Url(nacl.box(contentKey, wrapNonce, recipientPublicKey, senderSecretKey)),
      };
    }),
  };
}

export interface OpenGroupBoxInput extends GroupBoxCiphertext {
  recipientPeerId: string;
  recipientEncryptionSecretKey: string;
  senderEncryptionPublicKey: string;
}

/** Opens only the key wrap addressed to this peer, then authenticates the payload. */
export function openGroupBox(input: OpenGroupBoxInput): Uint8Array {
  const wrapped = input.wrappedKeys.find(({ recipientPeerId }) => recipientPeerId === input.recipientPeerId);
  if (!wrapped) throw new Error("GROUP_BOX_RECIPIENT_MISSING");
  const contentKey = nacl.box.open(
    fromBase64Url(wrapped.ciphertext),
    fromBase64Url(wrapped.nonce),
    fromBase64Url(input.senderEncryptionPublicKey),
    fromBase64Url(input.recipientEncryptionSecretKey),
  );
  if (!contentKey || contentKey.byteLength !== nacl.secretbox.keyLength) throw new Error("GROUP_KEY_DECRYPTION_FAILED");
  const plaintext = nacl.secretbox.open(
    fromBase64Url(input.ciphertext),
    fromBase64Url(input.nonce),
    contentKey,
  );
  if (!plaintext) throw new Error("GROUP_PAYLOAD_DECRYPTION_FAILED");
  return plaintext;
}

function uniqueRecipients(recipients: GroupBoxRecipient[]): GroupBoxRecipient[] {
  const result: GroupBoxRecipient[] = [];
  const peerIds = new Set<string>();
  for (const recipient of recipients) {
    if (peerIds.has(recipient.peerId)) throw new Error("DUPLICATE_GROUP_RECIPIENT");
    peerIds.add(recipient.peerId);
    result.push(recipient);
  }
  return result;
}
