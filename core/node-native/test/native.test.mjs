import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  coreVersion,
  decryptTextJson,
  encryptTextJson,
  verifyEnvelopeJson,
} from "../index.js";

const vector = JSON.parse(
  await readFile(new URL("../../protocol/test-vectors/v1.json", import.meta.url), "utf8"),
);

test("the Node addon is backed by the Rust core", () => {
  assert.equal(coreVersion(), "0.1.0");
  assert.equal(
    decryptTextJson(JSON.stringify({
      envelope: vector.envelope,
      senderSigningPublicKey: vector.sender_signing_public_key,
      senderEncryptionPublicKey: vector.sender_encryption_public_key,
      recipientEncryptionSecretKey: vector.recipient_encryption_secret_key,
    })),
    vector.plaintext,
  );
  assert.equal(verifyEnvelopeJson(JSON.stringify(vector.envelope), vector.sender_signing_public_key), true);
});

test("Rust reproduces the canonical TypeScript envelope through N-API", () => {
  const envelope = JSON.parse(encryptTextJson(JSON.stringify({
    messageId: vector.envelope.message_id,
    conversationId: vector.envelope.conversation_id,
    senderPeerId: vector.envelope.sender_peer_id,
    recipientPeerId: vector.envelope.recipient_peer_id,
    timestamp: vector.envelope.timestamp,
    plaintext: vector.plaintext,
    senderSigningSecretKey: vector.sender_signing_secret_seed,
    senderEncryptionSecretKey: vector.sender_encryption_secret_key,
    recipientEncryptionPublicKey: vector.recipient_encryption_public_key,
    nonce: Array.from({ length: 24 }, (_, index) => index + 1),
  })));
  assert.deepEqual(envelope, vector.envelope);
});
