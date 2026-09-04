import { signCanonical, verifyCanonical } from "./signatures.js";

export type OtpIdentityProofPurpose = "LOGIN" | "CANCEL_DELETION";

export interface OtpIdentityProofInput {
  email: string;
  code: string;
  /** Opaque server-issued id for the exact OTP challenge being proved. */
  otpAttemptId: string;
  deviceId: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  purpose: OtpIdentityProofPurpose;
}

function otpIdentityProofPayload(input: OtpIdentityProofInput) {
  return {
    domain: "atalk.auth.otp.identity-proof",
    version: 1,
    purpose: input.purpose,
    email: input.email.trim().toLowerCase(),
    otpCode: input.code,
    otpAttemptId: input.otpAttemptId,
    deviceId: input.deviceId.trim(),
    signingPublicKey: input.signingPublicKey,
    encryptionPublicKey: input.encryptionPublicKey,
  } as const;
}

/** Proves possession of the existing identity signing key for one OTP attempt and device. */
export function signOtpIdentityProof(
  input: OtpIdentityProofInput,
  signingSecretKey: string,
): string {
  return signCanonical(otpIdentityProofPayload(input), signingSecretKey);
}

/** Verifies a domain-separated identity proof without throwing on malformed input. */
export function verifyOtpIdentityProof(
  input: OtpIdentityProofInput,
  signature: string,
  signingPublicKey: string,
): boolean {
  return verifyCanonical(otpIdentityProofPayload(input), signature, signingPublicKey);
}
