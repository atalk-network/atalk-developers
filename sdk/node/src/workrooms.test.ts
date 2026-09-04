import { encryptWorkroomPayload, generateIdentityKeys, hashCanonical } from "@atalk/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentCredentials } from "./credential-store.js";
import type { AgentRuntimeState } from "./runtime-state-store.js";
import { approvalRequestId, defaultWorkroomAction, WorkroomClient, workroomStopReason } from "./workrooms.js";

const WORKROOM_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_AGENT_ID = "88888888-8888-4888-8888-888888888888";
const SENDER_ID = "44444444-4444-4444-8444-444444444444";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const PLAN_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-09-03T12:00:00.000Z";

describe("WorkroomClient durable polling", () => {
  it("commits only after successful authenticated handling and deduplicates retries", async () => {
    const agentKeys = generateIdentityKeys();
    const senderKeys = generateIdentityKeys();
    const agentPeer = peer(AGENT_ID, "@worker.agent", "AGENT", agentKeys);
    const senderPeer = peer(SENDER_ID, "@task.owner", "HUMAN", senderKeys);
    const credentials: AgentCredentials = { sessionToken: "token", peer: agentPeer, keys: agentKeys };
    const runtime: AgentRuntimeState = {
      version: 1, outbox: [], inbox: [], processedIncoming: {}, counterparties: {},
      workroomCursors: {}, processedWorkroomEvents: {},
    };
    const envelope = encryptWorkroomPayload({
      envelopeId: EVENT_ID,
      workroomId: WORKROOM_ID,
      senderPeerId: SENDER_ID,
      keyEpoch: 1,
      payload: {
        version: 1,
        kind: "plan",
        planId: PLAN_ID,
        planVersion: 1,
        summary: "Compare three vendors",
        steps: [{
          id: "compare-vendors", title: "Prepare the comparison", status: "executing",
          assignedPeerIds: [AGENT_ID], dependsOnStepIds: [],
        }, {
          id: "wait-for-owner", title: "Do not execute yet", status: "waiting_approval",
          assignedPeerIds: [AGENT_ID], dependsOnStepIds: [],
        }],
      },
      senderSigningSecretKey: senderKeys.signingSecretKey,
      senderEncryptionSecretKey: senderKeys.encryptionSecretKey,
      recipients: [{ peerId: AGENT_ID, encryptionPublicKey: agentKeys.encryptionPublicKey }],
      createdAt: NOW,
    });
    const descriptorEnvelope = encryptWorkroomPayload({
      envelopeId: "66666666-6666-4666-8666-666666666666",
      workroomId: WORKROOM_ID,
      senderPeerId: SENDER_ID,
      keyEpoch: 1,
      payload: { version: 1, title: "Vendor comparison", objective: "Compare three vendors" },
      senderSigningSecretKey: senderKeys.signingSecretKey,
      senderEncryptionSecretKey: senderKeys.encryptionSecretKey,
      recipients: [{ peerId: AGENT_ID, encryptionPublicKey: agentKeys.encryptionPublicKey }],
      createdAt: NOW,
    });
    const detail = {
      workroom: { id: WORKROOM_ID, currentKeyEpoch: 1, descriptorEnvelope, descriptorHash: hashCanonical(descriptorEnvelope) },
      membership: { peerId: AGENT_ID, role: "contributor" },
      members: [
        { membership: { peerId: AGENT_ID, peerType: "AGENT" }, peer: agentPeer },
        { membership: { peerId: SENDER_ID, peerType: "HUMAN" }, peer: senderPeer },
      ],
      threads: [], latestMandates: [], approvals: [], latestReceiptHash: null,
    };
    const record = {
      sequence: 1,
      event: {
        eventId: EVENT_ID, workroomId: WORKROOM_ID, threadId: THREAD_ID,
        actorPeerId: SENDER_ID, kind: "plan", envelope,
        idempotencyKey: "message-event-1", createdAt: NOW,
      },
      projection: { kind: "plan", id: PLAN_ID, version: 1 },
    };
    const request = vi.fn(async (path: string) => path.includes("/events?")
      ? { events: [record], nextAfterSequence: null }
      : detail);
    const client = new WorkroomClient({
      request,
      credentials: () => credentials,
      runtimeState: () => runtime,
      mutateRuntimeState: async (mutator: (state: AgentRuntimeState) => void) => mutator(runtime),
      uploadPart: vi.fn(), deletePart: vi.fn(), downloadAttachment: vi.fn(), downloadAttachmentTo: vi.fn(),
    } as never);

    await expect(client.poll(WORKROOM_ID, () => { throw new Error("consumer failed"); })).rejects.toThrow("consumer failed");
    expect(runtime.workroomCursors?.[WORKROOM_ID]).toBeUndefined();

    const handler = vi.fn();
    await expect(client.poll(WORKROOM_ID, handler)).resolves.toBe(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ directedToMe: true }));
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      content: { kind: "plan", steps: [{ id: "compare-vendors" }] },
      routing: { assignedSteps: [{ id: "compare-vendors" }] },
    });
    expect(runtime.workroomCursors?.[WORKROOM_ID]).toBe(1);

    await client.poll(WORKROOM_ID, handler);
    expect(handler).toHaveBeenCalledTimes(1);

    await expect(client.get(WORKROOM_ID)).resolves.toMatchObject({
      descriptor: { title: "Vendor comparison", objective: "Compare three vendors" },
    });
  });

  it("delivers only structured targets with two agents while retaining the complete audit view", async () => {
    const firstKeys = generateIdentityKeys();
    const secondKeys = generateIdentityKeys();
    const senderKeys = generateIdentityKeys();
    const firstPeer = peer(AGENT_ID, "@worker.one", "AGENT", firstKeys);
    const secondPeer = peer(SECOND_AGENT_ID, "@worker.two", "AGENT", secondKeys);
    const senderPeer = peer(SENDER_ID, "@task.owner", "HUMAN", senderKeys);
    const recipients = [
      { peerId: AGENT_ID, encryptionPublicKey: firstKeys.encryptionPublicKey },
      { peerId: SECOND_AGENT_ID, encryptionPublicKey: secondKeys.encryptionPublicKey },
    ];
    const descriptorEnvelope = encryptWorkroomPayload({
      envelopeId: "66666666-6666-4666-8666-666666666666",
      workroomId: WORKROOM_ID,
      senderPeerId: SENDER_ID,
      keyEpoch: 1,
      payload: { version: 1, title: "Shared task", objective: "Coordinate two agents safely" },
      senderSigningSecretKey: senderKeys.signingSecretKey,
      senderEncryptionSecretKey: senderKeys.encryptionSecretKey,
      recipients,
      createdAt: NOW,
    });
    const records = [
      workroomMessageRecord({
        sequence: 1,
        eventId: "99999999-9999-4999-8999-999999999991",
        body: "@worker.one appears only as ambiguous plain text",
        mentions: [],
        recipients,
        senderKeys,
      }),
      workroomMessageRecord({
        sequence: 2,
        eventId: "99999999-9999-4999-8999-999999999992",
        body: "Only the first worker should act",
        mentions: [{ peerId: AGENT_ID, handle: "@worker.one", peerType: "AGENT", intent: "direct" }],
        recipients,
        senderKeys,
      }),
      workroomMessageRecord({
        sequence: 3,
        eventId: "99999999-9999-4999-8999-999999999993",
        body: "Visible for context but not an autonomous instruction",
        mentions: [{ peerId: AGENT_ID, handle: "@worker.one", peerType: "AGENT", intent: "fyi" }],
        recipients,
        senderKeys,
      }),
      workroomMessageRecord({
        sequence: 4,
        eventId: "99999999-9999-4999-8999-999999999994",
        body: "My own undirected status update",
        mentions: [],
        recipients,
        senderId: AGENT_ID,
        senderKeys: firstKeys,
      }),
    ];
    const members = [
      { membership: { peerId: AGENT_ID, peerType: "AGENT" }, peer: firstPeer },
      { membership: { peerId: SECOND_AGENT_ID, peerType: "AGENT" }, peer: secondPeer },
      { membership: { peerId: SENDER_ID, peerType: "HUMAN" }, peer: senderPeer },
    ];
    const makeClient = (
      credentials: AgentCredentials,
      runtime: AgentRuntimeState,
      memberList = members,
      eventRecords = records,
    ) => {
      const detail = {
        workroom: {
          id: WORKROOM_ID,
          currentKeyEpoch: 1,
          descriptorEnvelope,
          descriptorHash: hashCanonical(descriptorEnvelope),
        },
        membership: { peerId: credentials.peer.id, role: "contributor" },
        members: memberList,
        threads: [], latestMandates: [], approvals: [], latestReceiptHash: null,
      };
      return new WorkroomClient({
        request: vi.fn(async (path: string) => path.includes("/events?")
          ? { events: eventRecords, nextAfterSequence: null }
          : detail),
        credentials: () => credentials,
        runtimeState: () => runtime,
        mutateRuntimeState: async (mutator: (state: AgentRuntimeState) => void) => mutator(runtime),
        uploadPart: vi.fn(), deletePart: vi.fn(), downloadAttachment: vi.fn(), downloadAttachmentTo: vi.fn(),
      } as never);
    };
    const firstRuntime = runtimeState();
    const secondRuntime = runtimeState();
    const firstClient = makeClient({ sessionToken: "one", peer: firstPeer, keys: firstKeys }, firstRuntime);
    const secondClient = makeClient({ sessionToken: "two", peer: secondPeer, keys: secondKeys }, secondRuntime);
    const firstHandler = vi.fn();
    const secondHandler = vi.fn();

    await firstClient.poll(WORKROOM_ID, firstHandler);
    await secondClient.poll(WORKROOM_ID, secondHandler);

    expect(firstHandler).toHaveBeenCalledTimes(1);
    expect(firstHandler).toHaveBeenCalledWith(expect.objectContaining({
      directedToMe: true,
      routing: expect.objectContaining({
        directedToMe: true,
        directMentions: [expect.objectContaining({ peerId: AGENT_ID })],
        assignedSteps: [],
      }),
      content: expect.objectContaining({ body: "Only the first worker should act" }),
    }));
    expect(secondHandler).not.toHaveBeenCalled();
    expect(firstRuntime.workroomCursors?.[WORKROOM_ID]).toBe(4);
    expect(secondRuntime.workroomCursors?.[WORKROOM_ID]).toBe(4);

    const audit = await secondClient.readAuditEvents(WORKROOM_ID, 0, 100);
    expect(audit.events).toHaveLength(4);
    expect(audit.events.map(({ directedToMe }) => directedToMe)).toEqual([false, false, false, false]);
    expect(secondRuntime.workroomCursors?.[WORKROOM_ID]).toBe(4);

    await expect(firstClient.message(WORKROOM_ID, THREAD_ID, "Do this", [{
      peerId: AGENT_ID, handle: "@worker.one", peerType: "AGENT", intent: "direct",
    }])).rejects.toThrow("WORKROOM_SELF_DIRECTION_FORBIDDEN");

    const mismatched = workroomMessageRecord({
      sequence: 5,
      eventId: "99999999-9999-4999-8999-999999999995",
      body: "Tampered routing identity",
      mentions: [{ peerId: AGENT_ID, handle: "@worker.two", peerType: "AGENT", intent: "direct" }],
      recipients,
      senderKeys,
    });
    const invalidClient = makeClient(
      { sessionToken: "one", peer: firstPeer, keys: firstKeys },
      runtimeState(),
      members,
      [mismatched],
    );
    await expect(invalidClient.readAuditEvents(WORKROOM_ID)).rejects
      .toThrow("WORKROOM_ROUTING_IDENTITY_MISMATCH");

    const inconsistentMemberClient = makeClient(
      { sessionToken: "one", peer: firstPeer, keys: firstKeys },
      runtimeState(),
      [
        { membership: { peerId: AGENT_ID, peerType: "HUMAN" }, peer: firstPeer },
        members[2]!,
      ],
      [records[0]!],
    );
    await expect(inconsistentMemberClient.readAuditEvents(WORKROOM_ID)).rejects
      .toThrow("WORKROOM_ROUTING_MEMBER_INVALID");

    const singletonRuntime = runtimeState();
    const singleton = makeClient(
      { sessionToken: "single", peer: firstPeer, keys: firstKeys },
      singletonRuntime,
      [members[0]!, members[2]!],
      [records[0]!],
    );
    const singletonHandler = vi.fn();
    await singleton.poll(WORKROOM_ID, singletonHandler);
    expect(singletonHandler).not.toHaveBeenCalled();
    expect(singletonRuntime.workroomCursors?.[WORKROOM_ID]).toBe(1);
  });

  it("uses the app's granular action vocabulary and reserves derived control events", () => {
    expect(defaultWorkroomAction("message")).toBe("message.send");
    expect(defaultWorkroomAction("plan")).toBe("plan.update");
    expect(defaultWorkroomAction("artifact_version")).toBe("file.create");
    expect(defaultWorkroomAction("deliverable")).toBe("deliverable.submit");
    expect(() => defaultWorkroomAction("cost")).toThrow("MUST_BE_DERIVED");
    expect(() => defaultWorkroomAction("approval_request")).toThrow("CREATED_BY_THE_MANDATE_GUARD");
    expect(workroomStopReason({ status: "cancelled" })).toBe("cancelled");
    expect(workroomStopReason({ status: "executing", deadline: "2020-01-01T00:00:00.000Z" })).toBe("deadline");
    expect(workroomStopReason({ status: "executing", deadline: "2099-01-01T00:00:00.000Z" })).toBeUndefined();
  });

  it("binds an approval id to the complete proposed effect while normalizing participant order", () => {
    const signed = {
      mandate: { mandateId: WORKROOM_ID, revision: 2 },
      signature: "signature",
    } as never;
    const input = {
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      operationId: SENDER_ID,
      action: "purchase.create",
      rationale: "Buy the approved report",
      summary: "Purchase vendor report",
      target: { type: "vendor", label: "Example", reference: "order-7" },
      effect: "Charge USD 25 and share the report in this Task",
      financialImpact: { currency: "USD", amountMinor: 2_500, kind: "exact" as const },
      dataCategories: ["vendor-report"],
      participantPeerIds: [AGENT_ID, THREAD_ID],
      tool: { tool: "vendor.api", action: "purchase", audience: "vendor.example" },
      dataAccesses: [],
      spend: { currency: "USD", amountMinor: 2_500 },
    };
    const requestId = approvalRequestId(input, signed, "owner-review");
    expect(requestId).toBe("0f580381-4e35-404b-b859-b1efda543a1c");
    expect(approvalRequestId({ ...input, participantPeerIds: [THREAD_ID, AGENT_ID] }, signed, "owner-review"))
      .toBe(requestId);
    expect(approvalRequestId({ ...input, effect: "Charge USD 50" }, signed, "owner-review"))
      .not.toBe(requestId);
    expect(approvalRequestId({
      ...input,
      financialImpact: { currency: "USD", amountMinor: 5_000, kind: "exact" as const },
      spend: { currency: "USD", amountMinor: 5_000 },
    }, signed, "owner-review")).not.toBe(requestId);
  });
});

function peer(id: string, handle: string, type: "HUMAN" | "AGENT", keys: ReturnType<typeof generateIdentityKeys>) {
  return {
    id, type, status: "ACTIVE" as const, handle, displayName: handle.slice(1),
    publicDiscoverable: false, organizationDiscoverable: true,
    signingPublicKey: keys.signingPublicKey, encryptionPublicKey: keys.encryptionPublicKey,
  };
}

function runtimeState(): AgentRuntimeState {
  return {
    version: 1,
    outbox: [],
    inbox: [],
    processedIncoming: {},
    counterparties: {},
    workroomCursors: {},
    processedWorkroomEvents: {},
  };
}

function workroomMessageRecord(input: {
  sequence: number;
  eventId: string;
  body: string;
  mentions: Array<{
    peerId: string;
    handle: string;
    peerType: "AGENT";
    intent: "direct" | "fyi";
  }>;
  recipients: Array<{ peerId: string; encryptionPublicKey: string }>;
  senderKeys: ReturnType<typeof generateIdentityKeys>;
  senderId?: string;
}) {
  const payload = {
    version: 1 as const,
    kind: "message" as const,
    threadId: THREAD_ID,
    body: input.body,
    mentions: input.mentions,
  };
  const envelope = encryptWorkroomPayload({
    envelopeId: input.eventId,
    workroomId: WORKROOM_ID,
    senderPeerId: input.senderId ?? SENDER_ID,
    keyEpoch: 1,
    payload,
    senderSigningSecretKey: input.senderKeys.signingSecretKey,
    senderEncryptionSecretKey: input.senderKeys.encryptionSecretKey,
    recipients: input.recipients,
    createdAt: NOW,
  });
  return {
    sequence: input.sequence,
    event: {
      eventId: input.eventId,
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      actorPeerId: input.senderId ?? SENDER_ID,
      kind: "message" as const,
      envelope,
      idempotencyKey: `message-${input.eventId}`,
      createdAt: NOW,
    },
  };
}
