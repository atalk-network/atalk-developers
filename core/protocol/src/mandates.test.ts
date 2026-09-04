import { describe, expect, it } from "vitest";

import { generateIdentityKeys } from "./crypto.js";
import { hashBase64UrlPayload, hashCanonical } from "./signatures.js";
import {
  decryptMandateTerms,
  encryptMandateTerms,
  hashSignedMandate,
  evaluateMandateUse,
  mandateCommitmentMatchesEncryptedTerms,
  mandateCommitmentMatchesTerms,
  mandateUseRequestSchema,
  signMandate,
  signMandateCommitment,
  signMandateEncryptedTermsEnvelope,
  signMandateRevocation,
  unsignedMandateSchema,
  verifyMandate,
  verifyMandateCommitment,
  verifyMandateEncryptedTermsEnvelope,
  verifyMandateRevocation,
  type UnsignedMandate,
} from "./mandates.js";

const MANDATE_ID = "11111111-1111-4111-8111-111111111111";
const WORKROOM_ID = "22222222-2222-4222-8222-222222222222";
const PRINCIPAL_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const APPROVER_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-03T12:00:00.000Z";

function mandate(): UnsignedMandate {
  return unsignedMandateSchema.parse({
    version: 1,
    mandateId: MANDATE_ID,
    revision: 1,
    workroomId: WORKROOM_ID,
    principalPeerId: PRINCIPAL_ID,
    actorPeerId: AGENT_ID,
    issuedByPeerId: PRINCIPAL_ID,
    purpose: "Research vendors and prepare a recommendation; do not purchase",
    allowedParticipantPeerIds: [PRINCIPAL_ID, AGENT_ID, APPROVER_ID],
    allowedData: [{
      resource: "workroom.attachments",
      permissions: ["read"],
      classification: "internal",
      allowedRecipientPeerIds: [PRINCIPAL_ID],
    }],
    allowedTools: [{ tool: "web.search", actions: ["query", "open"] }],
    allowedActions: ["research.read", "deliverable.submit"],
    spendLimits: [{ currency: "USD", maximumAmountMinor: 500, period: "mandate" }],
    volumeLimits: { maxMessages: 100, maxFiles: 5, custom: {} },
    validFrom: NOW,
    validUntil: "2026-09-04T12:00:00.000Z",
    delegation: { allowed: false, maxDepth: 0, allowedDelegatePeerIds: [], requirePrincipalApproval: true },
    approvalThresholds: [{
      id: "purchase",
      when: { action: "purchase.create" },
      requiredApprovals: 1,
      approverPeerIds: [APPROVER_ID],
    }],
    endConditions: [
      { id: "workroom.done", type: "workroom_completed" },
      { id: "principal.revoked", type: "explicit_revocation" },
    ],
    nonce: "bm9uY2U",
  });
}

describe("signed mandates", () => {
  it("signs full terms and a server-visible commitment without exposing purpose", () => {
    const keys = generateIdentityKeys();
    const signed = signMandate(mandate(), NOW, keys.signingSecretKey);
    expect(verifyMandate(signed, keys.signingPublicKey)).toBe(true);

    const ciphertext = "b3BhcXVlLXRlcm1z";
    const encryptedTerms = signMandateEncryptedTermsEnvelope({
      version: 1,
      cipherSuite: "ATALK_GROUP_BOX_V1",
      envelopeId: "77777777-7777-4777-8777-777777777777",
      mandateId: MANDATE_ID,
      revision: 1,
      senderPeerId: PRINCIPAL_ID,
      nonce: "bm9uY2U",
      ciphertext,
      ciphertextHash: hashBase64UrlPayload(ciphertext),
      wrappedKeys: [{ recipientPeerId: AGENT_ID, nonce: "d3JhcA", ciphertext: "a2V5" }],
      createdAt: NOW,
    }, keys.signingSecretKey);

    const commitment = signMandateCommitment({
      version: 1,
      mandateId: MANDATE_ID,
      revision: 1,
      workroomId: WORKROOM_ID,
      principalPeerId: PRINCIPAL_ID,
      actorPeerId: AGENT_ID,
      issuedByPeerId: PRINCIPAL_ID,
      validFrom: NOW,
      validUntil: "2026-09-04T12:00:00.000Z",
      termsHash: hashSignedMandate(signed),
      encryptedTermsHash: hashCanonical(encryptedTerms),
      committedAt: NOW,
    }, keys.signingSecretKey);
    expect(verifyMandateCommitment(commitment, keys.signingPublicKey)).toBe(true);
    expect(verifyMandateEncryptedTermsEnvelope(encryptedTerms, keys.signingPublicKey)).toBe(true);
    expect(mandateCommitmentMatchesTerms(commitment, signed)).toBe(true);
    expect(mandateCommitmentMatchesEncryptedTerms(commitment, encryptedTerms)).toBe(true);
    expect(JSON.stringify(commitment)).not.toContain("Research vendors");
  });

  it("detects tampered terms and signed revocations", () => {
    const keys = generateIdentityKeys();
    const signed = signMandate(mandate(), NOW, keys.signingSecretKey);
    const tampered = {
      ...signed,
      mandate: { ...signed.mandate, purpose: "Buy everything" },
    };
    expect(verifyMandate(tampered, keys.signingPublicKey)).toBe(false);

    const revocation = signMandateRevocation({
      version: 1,
      revocationId: "66666666-6666-4666-8666-666666666666",
      mandateId: MANDATE_ID,
      revokedByPeerId: PRINCIPAL_ID,
      revokedAt: NOW,
      reasonCode: "principal.cancelled",
    }, keys.signingSecretKey);
    expect(verifyMandateRevocation(revocation, keys.signingPublicKey)).toBe(true);
    expect(verifyMandateRevocation({
      ...revocation,
      revocation: { ...revocation.revocation, reasonCode: "other.reason" },
    }, keys.signingPublicKey)).toBe(false);
  });

  it("encrypts signed terms for the principal, agent and supervisors", () => {
    const issuer = generateIdentityKeys();
    const agent = generateIdentityKeys();
    const supervisor = generateIdentityKeys();
    const signed = signMandate(mandate(), NOW, issuer.signingSecretKey);
    const encrypted = encryptMandateTerms({
      envelopeId: "77777777-7777-4777-8777-777777777778",
      mandateId: MANDATE_ID,
      revision: 1,
      senderPeerId: PRINCIPAL_ID,
      signedMandate: signed,
      senderSigningSecretKey: issuer.signingSecretKey,
      senderEncryptionSecretKey: issuer.encryptionSecretKey,
      recipients: [
        { peerId: PRINCIPAL_ID, encryptionPublicKey: issuer.encryptionPublicKey },
        { peerId: AGENT_ID, encryptionPublicKey: agent.encryptionPublicKey },
        { peerId: APPROVER_ID, encryptionPublicKey: supervisor.encryptionPublicKey },
      ],
      createdAt: NOW,
    });

    const opened = decryptMandateTerms({
      envelope: encrypted,
      recipientPeerId: AGENT_ID,
      recipientEncryptionSecretKey: agent.encryptionSecretKey,
      senderEncryptionPublicKey: issuer.encryptionPublicKey,
      senderSigningPublicKey: issuer.signingPublicKey,
    });
    expect(opened).toEqual(signed);
  });

  it("rejects inverted validity and impossible approval thresholds", () => {
    const base = mandate();
    expect(unsignedMandateSchema.safeParse({
      ...base,
      validUntil: base.validFrom,
    }).success).toBe(false);
    expect(unsignedMandateSchema.safeParse({
      ...base,
      approvalThresholds: [{
        id: "impossible",
        when: { action: "purchase.create" },
        requiredApprovals: 2,
        approverPeerIds: [APPROVER_ID],
      }],
    }).success).toBe(false);
  });

  it("enforces tools, budgets, volumes and approval thresholds deterministically", () => {
    const terms = {
      ...mandate(),
      allowedActions: ["research.read", "deliverable.submit", "purchase.create"],
      volumeLimits: { maxActions: 10, custom: {} },
    };
    const baseRequest = mandateUseRequestSchema.parse({
      mandateId: MANDATE_ID,
      revision: 1,
      actingPeerId: AGENT_ID,
      participantPeerIds: [PRINCIPAL_ID],
      action: "research.read",
      tool: { tool: "web.search", action: "query" },
      volumeUsed: { actions: 4 },
      volumeDelta: { actions: 1 },
      evaluatedAt: "2026-09-03T13:00:00.000Z",
    });
    expect(evaluateMandateUse(terms, baseRequest)).toEqual({ status: "permitted" });
    const domainLimited = {
      ...terms,
      allowedTools: [{ tool: "web.search", actions: ["query", "open"], audience: "example.com, *.data.gov" }],
    };
    expect(evaluateMandateUse(domainLimited, {
      ...baseRequest,
      tool: { ...baseRequest.tool!, audience: "https://reports.data.gov/public" },
    })).toEqual({ status: "permitted" });
    expect(evaluateMandateUse(domainLimited, {
      ...baseRequest,
      tool: { ...baseRequest.tool!, audience: "https://unlisted.example.net" },
    })).toMatchObject({ status: "denied", code: "TOOL_DENIED" });
    expect(evaluateMandateUse(domainLimited, baseRequest))
      .toMatchObject({ status: "denied", code: "TOOL_DENIED" });
    expect(evaluateMandateUse(terms, {
      ...baseRequest,
      spend: { currency: "USD", amountMinor: 200 },
      spendUsedMinorByLimit: { "USD:mandate": 400 },
    })).toMatchObject({ status: "denied", code: "SPEND_LIMIT_EXCEEDED" });
    expect(evaluateMandateUse({
      ...terms,
      spendLimits: [{
        currency: "USD",
        maximumAmountMinor: 500,
        maximumPerOperationMinor: 100,
        period: "mandate" as const,
      }],
    }, {
      ...baseRequest,
      spend: { currency: "USD", amountMinor: 101 },
      spendUsedMinorByLimit: { "USD:mandate": 0 },
    })).toMatchObject({ status: "denied", code: "SPEND_LIMIT_EXCEEDED", detail: "USD:operation" });
    expect(evaluateMandateUse(terms, {
      ...baseRequest,
      volumeUsed: { ...baseRequest.volumeUsed, actions: 10 },
    })).toMatchObject({ status: "denied", code: "VOLUME_LIMIT_EXCEEDED" });

    const purchase = {
      ...baseRequest,
      action: "purchase.create",
      tool: undefined,
      spend: { currency: "USD" as const, amountMinor: 200 },
      spendUsedMinorByLimit: { "USD:mandate": 0 },
    };
    expect(evaluateMandateUse(terms, purchase)).toEqual({
      status: "requires_approval",
      thresholdIds: ["purchase"],
      reason: "THRESHOLD",
    });
    expect(evaluateMandateUse(terms, {
      ...purchase,
      verifiedApprovals: [{
        thresholdId: "purchase",
        decisionIds: ["77777777-7777-4777-8777-777777777777"],
        approverPeerIds: [APPROVER_ID],
      }],
    })).toEqual({ status: "permitted" });
  });
});
