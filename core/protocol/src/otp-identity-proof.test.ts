import { describe, expect, it } from "vitest";
import { generateIdentityKeys } from "./crypto.js";
import { signOtpIdentityProof, verifyOtpIdentityProof } from "./otp-identity-proof.js";

const proofInput = {
  email: "Human@Example.com ",
  code: "123456",
  otpAttemptId: "11111111-1111-4111-8111-111111111111",
  deviceId: "device-0000000000000001",
  signingPublicKey: "signing-public-key",
  encryptionPublicKey: "encryption-public-key",
  purpose: "LOGIN" as const,
};

describe("OTP identity possession proofs", () => {
  it("verifies only the exact OTP, account, device, keys and purpose", () => {
    const keys = generateIdentityKeys();
    const input = { ...proofInput, signingPublicKey: keys.signingPublicKey };
    const signature = signOtpIdentityProof(input, keys.signingSecretKey);

    expect(verifyOtpIdentityProof(input, signature, keys.signingPublicKey)).toBe(true);
    expect(verifyOtpIdentityProof({ ...input, code: "654321" }, signature, keys.signingPublicKey)).toBe(false);
    expect(verifyOtpIdentityProof({
      ...input,
      otpAttemptId: "22222222-2222-4222-8222-222222222222",
    }, signature, keys.signingPublicKey)).toBe(false);
    expect(verifyOtpIdentityProof({ ...input, email: "other@example.com" }, signature, keys.signingPublicKey)).toBe(false);
    expect(verifyOtpIdentityProof({ ...input, deviceId: "device-0000000000000002" }, signature, keys.signingPublicKey)).toBe(false);
    expect(verifyOtpIdentityProof({ ...input, encryptionPublicKey: "other-encryption-key" }, signature, keys.signingPublicKey)).toBe(false);
    expect(verifyOtpIdentityProof({ ...input, purpose: "CANCEL_DELETION" }, signature, keys.signingPublicKey)).toBe(false);
  });

  it("normalizes email and device whitespace canonically", () => {
    const keys = generateIdentityKeys();
    const input = { ...proofInput, signingPublicKey: keys.signingPublicKey };
    const signature = signOtpIdentityProof(input, keys.signingSecretKey);
    expect(verifyOtpIdentityProof({
      ...input,
      email: "human@example.com",
      deviceId: ` ${input.deviceId} `,
    }, signature, keys.signingPublicKey)).toBe(true);
  });
});
