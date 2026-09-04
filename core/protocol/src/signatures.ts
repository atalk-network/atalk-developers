import nacl from "tweetnacl";
import { canonicalBytes, fromBase64Url, toBase64Url } from "./encoding.js";

function canonicalValue(value: unknown): Parameters<typeof canonicalBytes>[0] {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("VALUE_NOT_CANONICALIZABLE");
  return JSON.parse(serialized) as Parameters<typeof canonicalBytes>[0];
}

/** Hashes a JSON value after recursively sorting object keys. */
export function hashCanonical(value: unknown): string {
  return toBase64Url(nacl.hash(canonicalBytes(canonicalValue(value))));
}

/** Hashes bytes transported as unpadded base64url. */
export function hashBase64UrlPayload(value: string): string {
  return toBase64Url(nacl.hash(fromBase64Url(value)));
}

/** Creates an Ed25519 signature over canonical JSON. */
export function signCanonical(value: unknown, signingSecretKey: string): string {
  return toBase64Url(
    nacl.sign.detached(
      canonicalBytes(canonicalValue(value)),
      fromBase64Url(signingSecretKey),
    ),
  );
}

/** Verifies an Ed25519 signature over canonical JSON. */
export function verifyCanonical(value: unknown, signature: string, signingPublicKey: string): boolean {
  try {
    return nacl.sign.detached.verify(
      canonicalBytes(canonicalValue(value)),
      fromBase64Url(signature),
      fromBase64Url(signingPublicKey),
    );
  } catch {
    return false;
  }
}
