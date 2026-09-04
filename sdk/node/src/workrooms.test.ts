import {
  encryptWorkroomPayload,
  generateIdentityKeys,
  hashCanonical,
  signWorkroomEncryptedEnvelope,
} from "@atalk/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentCredentials } from "./credential-store.js";
import { MemoryRuntimeStateStore, type AgentRuntimeState } from "./runtime-state-store.js";
import { approvalRequestId, defaultWorkroomAction, WorkroomClient, workroomStopReason } from "./workrooms.js";

const WORKROOM_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SECOND_AGENT_ID = "88888888-8888-4888-8888-888888888888";
const SENDER_ID = "44444444-4444-4444-8444-444444444444";
const MANAGER_ID = "99999999-9999-4999-8999-999999999999";
const EVENT_ID = "55555555-5555-4555-8555-555555555555";
const PLAN_ID = "77777777-7777-4777-8777-777777777777";
const NOW = "2026-09-03T12:00:00.000Z";

describe("WorkroomClient durable polling", () => {
  it("denies mandate execution while the current membership is observer", async () => {
    const keys = generateIdentityKeys();
    const credentials = {
      sessionToken: "observer-token",
      peer: peer(AGENT_ID, "@observer.agent", "AGENT", keys),
      keys,
    } satisfies AgentCredentials;
    const client = new WorkroomClient({
      credentials: () => credentials,
      runtimeState,
    } as never);
    vi.spyOn(client, "get").mockResolvedValue({
      workroom: { status: "executing" },
      membership: { role: "observer" },
    } as never);
    const effect = vi.fn(async () => ({ value: "must not run" }));

    await expect(client.executeMandatedAction({ workroomId: WORKROOM_ID } as never, effect)).resolves.toEqual({
      status: "denied",
      decision: { status: "denied", code: "MANDATE_MISMATCH", detail: "observer role is read-only" },
    });
    expect(effect).not.toHaveBeenCalled();
  });

  it("denies a current mandate when any mandate party is observer or no longer active", async () => {
    const keys = generateIdentityKeys();
    const credentials = {
      sessionToken: "party-role-token",
      peer: peer(AGENT_ID, "@worker.agent", "AGENT", keys),
      keys,
    } satisfies AgentCredentials;
    const parties = {
      actor: AGENT_ID,
      principal: SENDER_ID,
      issuer: MANAGER_ID,
    } as const;
    const scenarios = Object.entries(parties).flatMap(([name, peerId]) => [
      { name: `${name} observer`, peerId, observer: true },
      { name: `${name} removed`, peerId, observer: false },
    ]);

    for (const scenario of scenarios) {
      const baseMembers = [
        { membership: { peerId: AGENT_ID, role: "contributor" } },
        { membership: { peerId: SENDER_ID, role: "owner" } },
        { membership: { peerId: MANAGER_ID, role: "supervisor" } },
      ];
      const members = scenario.observer
        ? baseMembers.map((member) => member.membership.peerId === scenario.peerId
          ? { membership: { ...member.membership, role: "observer" } }
          : member)
        : baseMembers.filter((member) => member.membership.peerId !== scenario.peerId);
      const client = new WorkroomClient({ credentials: () => credentials, runtimeState } as never);
      vi.spyOn(client, "get").mockResolvedValue({
        workroom: { status: "executing" },
        membership: { role: scenario.peerId === AGENT_ID && scenario.observer ? "observer" : "contributor" },
        members,
        latestMandates: [{ mandate: { actorPeerId: AGENT_ID, revision: 1 } }],
      } as never);
      Reflect.set(client, "openMandate", vi.fn(() => ({
        mandate: {
          actorPeerId: AGENT_ID,
          principalPeerId: SENDER_ID,
          issuedByPeerId: MANAGER_ID,
        },
      })));

      const result = await client.guardMandateUse({ workroomId: WORKROOM_ID } as never);
      expect(result, scenario.name).toMatchObject({
        status: "denied",
        decision: { status: "denied", code: "MANDATE_MISMATCH" },
      });
    }
  });

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
      recipients: [agentPeer, senderPeer].map(({ id, encryptionPublicKey }) => ({
        peerId: id,
        encryptionPublicKey,
      })),
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
      recipients: [agentPeer, senderPeer].map(({ id, encryptionPublicKey }) => ({
        peerId: id,
        encryptionPublicKey,
      })),
      createdAt: NOW,
    });
    const detail = {
      workroom: { id: WORKROOM_ID, currentKeyEpoch: 1, descriptorEnvelope, descriptorHash: hashCanonical(descriptorEnvelope) },
      membership: { peerId: AGENT_ID, role: "contributor" },
      members: [
        { membership: { peerId: AGENT_ID, peerType: "AGENT", role: "contributor" }, peer: agentPeer },
        { membership: { peerId: SENDER_ID, peerType: "HUMAN", role: "owner" }, peer: senderPeer },
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
      membershipSnapshot: [
        eventMember(agentPeer, "contributor", agentKeys),
        eventMember(senderPeer, "owner", senderKeys),
      ],
    };
    const request = vi.fn(async (path: string) => path.includes("/events?")
      ? { events: path.includes("afterSequence=1") ? [] : [record], nextAfterSequence: null }
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
    expect(runtime.workroomEventFailures ?? {}).toEqual({});

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
      { peerId: SENDER_ID, encryptionPublicKey: senderKeys.encryptionPublicKey },
    ];
    const eventSnapshot = [
      eventMember(firstPeer, "contributor", firstKeys),
      eventMember(secondPeer, "contributor", secondKeys),
      eventMember(senderPeer, "owner", senderKeys),
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
    ].map((record) => ({ ...record, membershipSnapshot: eventSnapshot }));
    const members = [
      { membership: { peerId: AGENT_ID, peerType: "AGENT", role: "contributor" }, peer: firstPeer },
      { membership: { peerId: SECOND_AGENT_ID, peerType: "AGENT", role: "contributor" }, peer: secondPeer },
      { membership: { peerId: SENDER_ID, peerType: "HUMAN", role: "owner" }, peer: senderPeer },
    ];
    const makeClient = (
      credentials: AgentCredentials,
      runtime: AgentRuntimeState,
      memberList = members,
      eventRecords: Array<Omit<(typeof records)[number], "membershipSnapshot"> & {
        membershipSnapshot?: ReturnType<typeof eventMember>[];
      }> = records,
      ownRole: "contributor" | "observer" = "contributor",
    ) => {
      const detail = {
        workroom: {
          id: WORKROOM_ID,
          currentKeyEpoch: 1,
          descriptorEnvelope,
          descriptorHash: hashCanonical(descriptorEnvelope),
        },
        membership: { peerId: credentials.peer.id, role: ownRole },
        members: memberList,
        threads: [], latestMandates: [], approvals: [], latestReceiptHash: null,
      };
      return new WorkroomClient({
        request: vi.fn(async (path: string) => {
          if (!path.includes("/events?")) return detail;
          const afterSequence = Number(new URL(path, "https://sdk.invalid").searchParams.get("afterSequence") ?? 0);
          return {
            events: eventRecords.filter(({ sequence }) => sequence > afterSequence),
            nextAfterSequence: null,
          };
        }),
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

    const mismatched = {
      ...workroomMessageRecord({
        sequence: 5,
        eventId: "99999999-9999-4999-8999-999999999995",
        body: "Tampered routing identity",
        mentions: [{ peerId: AGENT_ID, handle: "@worker.two", peerType: "AGENT", intent: "direct" }],
        recipients,
        senderKeys,
      }),
      membershipSnapshot: eventSnapshot,
    };
    const invalidClient = makeClient(
      { sessionToken: "one", peer: firstPeer, keys: firstKeys },
      runtimeState(),
      members,
      [mismatched],
    );
    await expect(invalidClient.readAuditEvents(WORKROOM_ID)).rejects
      .toThrow("WORKROOM_ROUTING_IDENTITY_MISMATCH");

    const { membershipSnapshot: _legacySnapshot, ...legacyRecord } = records[1]!;
    const legacyRuntime = runtimeState();
    const legacyClient = makeClient(
      { sessionToken: "legacy", peer: firstPeer, keys: firstKeys },
      legacyRuntime,
      members,
      [legacyRecord],
    );
    const legacyHandler = vi.fn();
    await legacyClient.poll(WORKROOM_ID, legacyHandler);
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(legacyRuntime.workroomCursors?.[WORKROOM_ID]).toBe(2);
    await expect(legacyClient.readAuditEvents(WORKROOM_ID)).resolves.toMatchObject({
      events: [{ directedToMe: false, content: { body: "Only the first worker should act" } }],
    });

    const boundEnvelope = records[1]!.event.envelope;
    if (boundEnvelope.cipherSuite !== "ATALK_GROUP_BOX_V1") throw new Error("expected group box");
    const { senderSignature: _signature, ...unsignedBoundEnvelope } = boundEnvelope;
    const allMissingEnvelope = signWorkroomEncryptedEnvelope({
      ...unsignedBoundEnvelope,
      wrappedKeys: unsignedBoundEnvelope.wrappedKeys.map(({
        recipientEncryptionKeyHash: _recipientKeyHash,
        ...wrapped
      }) => wrapped),
    }, senderKeys.signingSecretKey);
    const nMinusOneRecord = {
      ...records[1]!,
      event: { ...records[1]!.event, envelope: allMissingEnvelope },
    };
    const nMinusOneRuntime = runtimeState();
    const nMinusOneClient = makeClient(
      { sessionToken: "n-minus-one", peer: firstPeer, keys: firstKeys },
      nMinusOneRuntime,
      members,
      [nMinusOneRecord],
    );
    const nMinusOneHandler = vi.fn();
    await nMinusOneClient.poll(WORKROOM_ID, nMinusOneHandler);
    expect(nMinusOneHandler).not.toHaveBeenCalled();
    expect(nMinusOneRuntime.workroomCursors?.[WORKROOM_ID]).toBe(2);

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

    const observerMembers = members.map((member) => member.membership.peerId === AGENT_ID
      ? { ...member, membership: { ...member.membership, role: "observer" as const } }
      : member);
    const observerRuntime = runtimeState();
    const observer = makeClient(
      { sessionToken: "observer", peer: firstPeer, keys: firstKeys },
      observerRuntime,
      observerMembers,
      [records[1]!],
      "observer",
    );
    const observerHandler = vi.fn();
    await observer.poll(WORKROOM_ID, observerHandler);
    expect(observerHandler).not.toHaveBeenCalled();
    expect(observerRuntime.workroomCursors?.[WORKROOM_ID]).toBe(2);
    await expect(observer.readAuditEvents(WORKROOM_ID)).resolves.toMatchObject({
      events: [{ directedToMe: false, routing: { directedToMe: false } }],
    });

    const publisher = makeClient(
      { sessionToken: "publisher", peer: secondPeer, keys: secondKeys },
      runtimeState(),
      observerMembers,
      [],
    );
    await expect(publisher.message(WORKROOM_ID, THREAD_ID, "Observer must not execute", [{
      peerId: AGENT_ID, handle: "@worker.one", peerType: "AGENT", intent: "direct",
    }])).rejects.toThrow("WORKROOM_ROUTING_TARGET_NOT_EXECUTABLE");

    const historicalRecipients = recipients;
    const historicalRecord = {
      ...workroomMessageRecord({
        sequence: 5,
        eventId: "99999999-9999-4999-8999-999999999995",
        body: "This was valid before worker one left",
        mentions: [{ peerId: AGENT_ID, handle: "@worker.one", peerType: "AGENT", intent: "direct" }],
        recipients: historicalRecipients,
        senderKeys,
      }),
      membershipSnapshot: [
        eventMember(firstPeer, "contributor", firstKeys),
        eventMember(secondPeer, "contributor", secondKeys),
        eventMember(senderPeer, "owner", senderKeys),
      ],
    };
    const remainingRuntime = runtimeState();
    const remainingMember = makeClient(
      { sessionToken: "remaining", peer: secondPeer, keys: secondKeys },
      remainingRuntime,
      [members[1]!, members[2]!],
      [historicalRecord],
    );
    const remainingHandler = vi.fn();
    await remainingMember.poll(WORKROOM_ID, remainingHandler);
    expect(remainingHandler).not.toHaveBeenCalled();
    expect(remainingRuntime.workroomCursors?.[WORKROOM_ID]).toBe(5);
    await expect(remainingMember.readAuditEvents(WORKROOM_ID)).resolves.toMatchObject({
      events: [{ content: { body: "This was valid before worker one left" } }],
    });

    const promotedRuntime = runtimeState();
    const promoted = makeClient(
      { sessionToken: "promoted", peer: firstPeer, keys: firstKeys },
      promotedRuntime,
      members,
      [{
        ...historicalRecord,
        membershipSnapshot: historicalRecord.membershipSnapshot.map((snapshot) =>
          snapshot.peerId === AGENT_ID ? { ...snapshot, role: "observer" as const } : snapshot),
      }],
    );
    const promotedHandler = vi.fn();
    await promoted.poll(WORKROOM_ID, promotedHandler);
    expect(promotedHandler).not.toHaveBeenCalled();
    expect(promotedRuntime.workroomCursors?.[WORKROOM_ID]).toBe(5);
  });

  it("durably quarantines a poisoned event after bounded retries and continues after restart", async () => {
    const agentKeys = generateIdentityKeys();
    const senderKeys = generateIdentityKeys();
    const agentPeer = peer(AGENT_ID, "@worker.agent", "AGENT", agentKeys);
    const senderPeer = peer(SENDER_ID, "@task.owner", "HUMAN", senderKeys);
    const credentials: AgentCredentials = { sessionToken: "token", peer: agentPeer, keys: agentKeys };
    const recipients = [agentPeer, senderPeer].map(({ id, encryptionPublicKey }) => ({
      peerId: id,
      encryptionPublicKey,
    }));
    const snapshot = [
      eventMember(agentPeer, "contributor", agentKeys),
      eventMember(senderPeer, "owner", senderKeys),
    ];
    const validPoisonPayload = workroomMessageRecord({
      sequence: 1,
      eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      body: "This ciphertext claims the wrong kind",
      mentions: [{ peerId: AGENT_ID, handle: "@worker.agent", peerType: "AGENT", intent: "direct" }],
      recipients,
      senderKeys,
    });
    const poison = {
      ...validPoisonPayload,
      event: { ...validPoisonPayload.event, kind: "activity" as const },
      membershipSnapshot: snapshot,
    };
    const later = {
      ...workroomMessageRecord({
        sequence: 2,
        eventId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        body: "This directed event must still run",
        mentions: [{ peerId: AGENT_ID, handle: "@worker.agent", peerType: "AGENT", intent: "direct" }],
        recipients,
        senderKeys,
      }),
      membershipSnapshot: snapshot,
    };
    const detail = {
      workroom: { id: WORKROOM_ID, currentKeyEpoch: 1 },
      membership: { peerId: AGENT_ID, role: "contributor" },
      members: [
        { membership: { peerId: AGENT_ID, peerType: "AGENT", role: "contributor" }, peer: agentPeer },
        { membership: { peerId: SENDER_ID, peerType: "HUMAN", role: "owner" }, peer: senderPeer },
      ],
      threads: [], latestMandates: [], approvals: [], latestReceiptHash: null,
    };
    const makeClient = (
      runtime: AgentRuntimeState,
      eventRecords: Array<typeof poison | typeof later> = [poison, later],
      nextAfterSequence: number | null = null,
    ) => {
      const client = new WorkroomClient({
        request: vi.fn(async () => ({ events: eventRecords, nextAfterSequence })),
        credentials: () => credentials,
        runtimeState: () => runtime,
        mutateRuntimeState: async (mutator: (state: AgentRuntimeState) => void) => mutator(runtime),
        uploadPart: vi.fn(), deletePart: vi.fn(), downloadAttachment: vi.fn(), downloadAttachmentTo: vi.fn(),
      } as never);
      vi.spyOn(client, "get").mockResolvedValue(detail as never);
      return client;
    };

    const beforeRestart = runtimeState();
    const firstClient = makeClient(beforeRestart);
    const handlerBeforeRestart = vi.fn();
    await expect(firstClient.poll(WORKROOM_ID, handlerBeforeRestart)).rejects
      .toThrow("WORKROOM_EVENT_KIND_MISMATCH");
    await expect(firstClient.poll(WORKROOM_ID, handlerBeforeRestart)).rejects
      .toThrow("WORKROOM_EVENT_KIND_MISMATCH");
    expect(handlerBeforeRestart).not.toHaveBeenCalled();
    expect(beforeRestart.workroomCursors?.[WORKROOM_ID]).toBeUndefined();
    expect(beforeRestart.workroomEventFailures?.[poison.event.eventId]).toMatchObject({
      attempts: 2,
      status: "retrying",
    });

    const stateStore = new MemoryRuntimeStateStore();
    await stateStore.save(beforeRestart);
    const afterRestart = await stateStore.load();
    if (!afterRestart) throw new Error("runtime state was not persisted");
    const renamedPoison = {
      ...poison,
      event: {
        ...poison.event,
        eventId: "abababab-abab-4bab-8bab-abababababab",
        idempotencyKey: "renamed-poison",
      },
    };
    const restartedClient = makeClient(afterRestart, [renamedPoison, later]);
    const handlerAfterRestart = vi.fn();
    const quarantined = vi.fn();

    await expect(restartedClient.poll(WORKROOM_ID, handlerAfterRestart, {
      onEventQuarantined: quarantined,
    })).resolves.toBe(2);
    expect(handlerAfterRestart).toHaveBeenCalledTimes(1);
    expect(handlerAfterRestart).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({ eventId: later.event.eventId }),
      directedToMe: true,
    }));
    expect(quarantined).toHaveBeenCalledWith(expect.objectContaining({
      eventId: renamedPoison.event.eventId,
      envelopeId: poison.event.envelope.envelopeId,
      attempts: 3,
      status: "quarantined",
    }));
    expect(afterRestart.workroomCursors?.[WORKROOM_ID]).toBe(2);
    expect(restartedClient.listQuarantinedEvents(WORKROOM_ID)).toEqual([
      expect.objectContaining({
        eventId: renamedPoison.event.eventId,
        envelopeId: poison.event.envelope.envelopeId,
        attempts: 3,
        status: "quarantined",
      }),
    ]);
    await expect(restartedClient.readAuditEvents(WORKROOM_ID)).rejects
      .toThrow("WORKROOM_EVENT_KIND_MISMATCH");

    const otherWorkroomId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const crossWorkroom = {
      ...later,
      event: {
        ...later.event,
        workroomId: otherWorkroomId,
        envelope: { ...later.event.envelope, workroomId: otherWorkroomId },
      },
    };
    const mismatchedTimestamp = {
      ...later,
      event: { ...later.event, createdAt: "2026-09-03T12:00:01.000Z" },
    };
    const invalidPages = [
      { records: [crossWorkroom], next: null, code: "WORKROOM_EVENT_PAGE_WORKROOM_MISMATCH" },
      { records: [later, later], next: null, code: "WORKROOM_EVENT_SEQUENCE_INVALID" },
      { records: [{ ...later, sequence: 2 }, { ...poison, sequence: 1 }], next: null,
        code: "WORKROOM_EVENT_SEQUENCE_INVALID" },
      { records: [mismatchedTimestamp], next: null, code: "WORKROOM_EVENT_METADATA_MISMATCH" },
      { records: [later], next: 99, code: "WORKROOM_EVENT_CURSOR_INVALID" },
    ];
    for (const invalid of invalidPages) {
      const invalidRuntime = runtimeState();
      const invalidClient = makeClient(invalidRuntime, invalid.records, invalid.next);
      await expect(invalidClient.poll(WORKROOM_ID, vi.fn())).rejects.toThrow(invalid.code);
      expect(invalidRuntime.workroomCursors).toEqual({});
      expect(invalidRuntime.workroomEventFailures).toEqual({});
    }

    const renamedReplay = {
      ...later,
      sequence: 3,
      event: {
        ...later.event,
        eventId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        idempotencyKey: "renamed-by-relay",
      },
    };
    const replayRuntime = runtimeState();
    const replayClient = makeClient(replayRuntime, [later, renamedReplay]);
    const replayHandler = vi.fn();
    await expect(replayClient.poll(WORKROOM_ID, replayHandler)).resolves.toBe(3);
    expect(replayHandler).toHaveBeenCalledTimes(1);
    expect(replayRuntime.workroomCursors?.[WORKROOM_ID]).toBe(3);
    expect(replayRuntime.processedWorkroomEvents?.[later.event.envelope.envelopeId]).toBe(true);
    expect(replayRuntime.processedWorkroomEvents?.[renamedReplay.event.eventId]).toBeUndefined();
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
    workroomEventFailures: {},
  };
}

function eventMember(
  value: ReturnType<typeof peer>,
  role: "owner" | "contributor" | "observer",
  keys: ReturnType<typeof generateIdentityKeys>,
) {
  return {
    peerId: value.id,
    peerType: value.type,
    role,
    handle: value.handle,
    signingPublicKey: keys.signingPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
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
