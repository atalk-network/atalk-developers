import { describe, expect, it } from "vitest";

import { generateIdentityKeys } from "./crypto.js";
import { hashBase64UrlPayload, hashCanonical } from "./signatures.js";
import {
  appendWorkroomEventSchema,
  decryptWorkroomPayload,
  encryptWorkroomPayload,
  signWorkroomEncryptedEnvelope,
  signWorkroomMembershipConsent,
  resolveWorkroomRouting,
  validateWorkroomContentRouting,
  verifyWorkroomMembershipConsent,
  verifyWorkroomEncryptedEnvelope,
  workroomApproverRoleSchema,
  workroomApprovalRequestPayloadSchema,
  workroomContentPayloadSchema,
  workroomPlanPayloadSchema,
} from "./workrooms.js";

const WORKROOM_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-03T12:00:00.000Z";

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    cipherSuite: "ATALK_GROUP_BOX_V1",
    envelopeId: "66666666-6666-4666-8666-666666666666",
    workroomId: WORKROOM_ID,
    senderPeerId: HUMAN_ID,
    keyEpoch: 2,
    nonce: "bm9uY2U",
    ciphertext: "Y2lwaGVydGV4dA",
    ciphertextHash: hashCanonical("ciphertext"),
    senderSignature: "c2lnbmF0dXJl",
    wrappedKeys: [
      { recipientPeerId: HUMAN_ID, nonce: "bm9uY2Ux", ciphertext: "a2V5MQ" },
      { recipientPeerId: AGENT_ID, nonce: "bm9uY2Uy", ciphertext: "a2V5Mg" },
    ],
    createdAt: NOW,
    ...overrides,
  };
}

describe("workroom protocol", () => {
  it("reserves approval authority for owners and supervisors", () => {
    expect(["owner", "supervisor"].every((role) =>
      workroomApproverRoleSchema.safeParse(role).success)).toBe(true);
    expect(workroomApproverRoleSchema.safeParse("contributor").success).toBe(false);
    expect(workroomApproverRoleSchema.safeParse("observer").success).toBe(false);
  });

  it("models encrypted multi-member activity with explicit agent mentions", () => {
    const content = workroomContentPayloadSchema.parse({
      version: 1,
      kind: "activity",
      threadId: THREAD_ID,
      activityType: "agent.tool.completed",
      summary: "Research package prepared",
      mentions: [{ peerId: AGENT_ID, handle: "@research.agent", peerType: "AGENT", intent: "direct" }],
      sourceEventIds: [],
      attributes: { tool: "web.search" },
    });
    expect(content.kind).toBe("activity");
    expect(content.mentions).toEqual([
      expect.objectContaining({ peerId: AGENT_ID, peerType: "AGENT", intent: "direct" }),
    ]);

    const event = appendWorkroomEventSchema.parse({
      eventId: "77777777-7777-4777-8777-777777777777",
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      actorPeerId: HUMAN_ID,
      kind: "activity",
      envelope: envelope(),
      idempotencyKey: "activity-0001",
      createdAt: NOW,
    });
    expect(event.envelope.wrappedKeys).toHaveLength(2);
  });

  it("binds structured routing to the exact active identity and rejects self direction", () => {
    const peers = [
      { id: HUMAN_ID, handle: "@task.owner", type: "HUMAN", status: "ACTIVE" },
      { id: AGENT_ID, handle: "@research.agent", type: "AGENT", status: "ACTIVE" },
    ] as const;
    const message = workroomContentPayloadSchema.parse({
      version: 1, kind: "message", threadId: THREAD_ID, body: "Research this",
      mentions: [{ peerId: AGENT_ID, handle: "@research.agent", peerType: "AGENT", intent: "direct" }],
    });
    expect(() => validateWorkroomContentRouting(message, peers, HUMAN_ID)).not.toThrow();
    expect(() => validateWorkroomContentRouting({
      ...message,
      mentions: [{ ...message.mentions[0]!, handle: "@task.owner" }],
    }, peers, HUMAN_ID)).toThrow("WORKROOM_ROUTING_IDENTITY_MISMATCH");
    expect(() => validateWorkroomContentRouting({
      ...message,
      mentions: [{ peerId: HUMAN_ID, handle: "@task.owner", peerType: "HUMAN", intent: "direct" }],
    }, peers, HUMAN_ID)).toThrow("WORKROOM_SELF_DIRECTION_FORBIDDEN");
    expect(() => validateWorkroomContentRouting({
      ...message,
      mentions: [{ ...message.mentions[0]! }, { ...message.mentions[0]! }],
    }, peers, HUMAN_ID)).toThrow("WORKROOM_ROUTING_DUPLICATE_TARGET");
    const stalePlan = workroomContentPayloadSchema.parse({
      version: 1, kind: "plan", planVersion: 1, summary: "Stale assignment",
      steps: [{
        id: "stale", title: "Do not dispatch", status: "executing",
        assignedPeerIds: [OTHER_ID], dependsOnStepIds: [],
      }],
    });
    expect(() => validateWorkroomContentRouting(stalePlan, peers, HUMAN_ID))
      .toThrow("WORKROOM_ROUTING_TARGET_NOT_ACTIVE");
  });

  it("starts autonomous turns only for direct mentions or own executable plan steps", () => {
    const direct = workroomContentPayloadSchema.parse({
      version: 1, kind: "message", threadId: THREAD_ID, body: "Act",
      mentions: [{ peerId: AGENT_ID, handle: "@research.agent", peerType: "AGENT", intent: "direct" }],
    });
    expect(resolveWorkroomRouting(direct, AGENT_ID, HUMAN_ID)).toMatchObject({
      directedToMe: true, directMentions: [{ peerId: AGENT_ID }], assignedSteps: [],
    });
    expect(resolveWorkroomRouting({
      ...direct, mentions: [{ ...direct.mentions[0]!, intent: "fyi" }],
    }, AGENT_ID, HUMAN_ID).directedToMe).toBe(false);
    expect(resolveWorkroomRouting(direct, HUMAN_ID, HUMAN_ID).directedToMe).toBe(false);

    const plan = workroomContentPayloadSchema.parse({
      version: 1, kind: "plan", planVersion: 1, summary: "Coordinate",
      steps: [
        { id: "now", title: "Run now", status: "executing", assignedPeerIds: [AGENT_ID], dependsOnStepIds: [] },
        { id: "blocked", title: "Wait", status: "blocked", assignedPeerIds: [AGENT_ID], dependsOnStepIds: [] },
        { id: "other", title: "Other peer", status: "executing", assignedPeerIds: [OTHER_ID], dependsOnStepIds: [] },
      ],
    });
    const routing = resolveWorkroomRouting(plan, AGENT_ID, HUMAN_ID);
    expect(routing.directedToMe).toBe(true);
    expect(routing.assignedSteps.map(({ id }) => id)).toEqual(["now"]);
    expect(resolveWorkroomRouting({
      ...plan, steps: plan.steps.filter(({ id }) => id !== "now"),
    }, AGENT_ID, HUMAN_ID).directedToMe).toBe(false);
  });

  it("rejects invalid plan dependencies", () => {
    const parsed = workroomPlanPayloadSchema.safeParse({
      version: 1,
      kind: "plan",
      planVersion: 1,
      summary: "Ship the report",
      steps: [{
        id: "draft",
        title: "Draft",
        status: "executing",
        assignedPeerIds: [AGENT_ID],
        dependsOnStepIds: ["missing"],
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects approval thresholds larger than the eligible set", () => {
    const parsed = workroomApprovalRequestPayloadSchema.safeParse({
      version: 1,
      kind: "approval_request",
      action: "invoice.pay",
      rationale: "Payment required to continue",
      requestedApproverPeerIds: [HUMAN_ID, HUMAN_ID],
      requiredApprovals: 2,
      relatedEventIds: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("binds an event envelope to its workroom and actor", () => {
    const base = {
      eventId: "77777777-7777-4777-8777-777777777777",
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      actorPeerId: HUMAN_ID,
      kind: "message",
      idempotencyKey: "message-0001",
      createdAt: NOW,
    };
    expect(appendWorkroomEventSchema.safeParse({ ...base, envelope: envelope({ workroomId: OTHER_ID }) }).success).toBe(false);
    expect(appendWorkroomEventSchema.safeParse({ ...base, envelope: envelope({ senderPeerId: AGENT_ID }) }).success).toBe(false);
  });

  it("verifies the ciphertext hash and sender signature", () => {
    const keys = generateIdentityKeys();
    const ciphertext = "ZW5jcnlwdGVk";
    const signed = signWorkroomEncryptedEnvelope({
      version: 1,
      cipherSuite: "ATALK_GROUP_BOX_V1",
      envelopeId: "88888888-8888-4888-8888-888888888888",
      workroomId: WORKROOM_ID,
      senderPeerId: HUMAN_ID,
      keyEpoch: 1,
      nonce: "bm9uY2U",
      ciphertext,
      ciphertextHash: hashBase64UrlPayload(ciphertext),
      wrappedKeys: [{ recipientPeerId: HUMAN_ID, nonce: "d3JhcA", ciphertext: "a2V5" }],
      createdAt: NOW,
    }, keys.signingSecretKey);
    expect(verifyWorkroomEncryptedEnvelope(signed, keys.signingPublicKey)).toBe(true);
    expect(verifyWorkroomEncryptedEnvelope({ ...signed, ciphertext: "dGFtcGVyZWQ" }, keys.signingPublicKey)).toBe(false);
  });

  it("binds membership consent to one exact invitation", () => {
    const keys = generateIdentityKeys();
    const signed = signWorkroomMembershipConsent({
      version: 1,
      consentId: "99999999-9999-4999-8999-999999999999",
      workroomId: WORKROOM_ID,
      membershipId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      invitedByPeerId: HUMAN_ID,
      memberPeerId: OTHER_ID,
      peerType: "HUMAN",
      role: "contributor",
      acceptedAt: NOW,
      validUntil: "2026-09-03T13:00:00.000Z",
    }, keys.signingSecretKey);
    expect(verifyWorkroomMembershipConsent(signed, keys.signingPublicKey)).toBe(true);
    expect(verifyWorkroomMembershipConsent({
      ...signed,
      consent: { ...signed.consent, role: "owner" },
    }, keys.signingPublicKey)).toBe(false);
  });

  it("encrypts one payload for several humans and agents", () => {
    const sender = generateIdentityKeys();
    const human = generateIdentityKeys();
    const agent = generateIdentityKeys();
    const encrypted = encryptWorkroomPayload({
      envelopeId: "88888888-8888-4888-8888-888888888889",
      workroomId: WORKROOM_ID,
      senderPeerId: HUMAN_ID,
      keyEpoch: 0,
      payload: { version: 1, objective: "Compare three suppliers" },
      senderSigningSecretKey: sender.signingSecretKey,
      senderEncryptionSecretKey: sender.encryptionSecretKey,
      recipients: [
        { peerId: OTHER_ID, encryptionPublicKey: human.encryptionPublicKey },
        { peerId: AGENT_ID, encryptionPublicKey: agent.encryptionPublicKey },
      ],
      createdAt: NOW,
    });

    expect(encrypted.wrappedKeys.map(({ recipientPeerId }) => recipientPeerId)).toEqual([OTHER_ID, AGENT_ID]);
    expect(decryptWorkroomPayload<{ objective: string }>({
      envelope: encrypted,
      recipientPeerId: AGENT_ID,
      recipientEncryptionSecretKey: agent.encryptionSecretKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      senderSigningPublicKey: sender.signingPublicKey,
    })).toEqual({ version: 1, objective: "Compare three suppliers" });
    expect(() => decryptWorkroomPayload({
      envelope: encrypted,
      recipientPeerId: HUMAN_ID,
      recipientEncryptionSecretKey: sender.encryptionSecretKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      senderSigningPublicKey: sender.signingPublicKey,
    })).toThrow("GROUP_BOX_RECIPIENT_MISSING");
  });
});
