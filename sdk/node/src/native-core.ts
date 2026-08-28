import {
  coreVersion,
  decryptTextJson,
  encryptTextJson,
  generateIdentityKeysJson,
} from "@atalk/core-native";
import type { EncryptTextInput, EncryptedEnvelope, IdentityKeyPair } from "@atalk/protocol";

export const RUST_CORE_VERSION = coreVersion();

export function generateIdentityKeysNative(): IdentityKeyPair {
  return JSON.parse(generateIdentityKeysJson()) as IdentityKeyPair;
}

export function encryptTextNative(input: EncryptTextInput): EncryptedEnvelope {
  return JSON.parse(encryptTextJson(JSON.stringify(input))) as EncryptedEnvelope;
}

export function decryptTextNative(input: {
  envelope: EncryptedEnvelope;
  senderSigningPublicKey: string;
  senderEncryptionPublicKey: string;
  recipientEncryptionSecretKey: string;
}): string {
  return decryptTextJson(JSON.stringify(input));
}
