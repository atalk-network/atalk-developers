import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAttachmentMessage, decryptAttachmentChunk, decryptText, encryptText, generateIdentityKeys, serverFrameSchema, type PublicPeer, type ServerFrame } from "@atalk/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Agent } from "./agent.js";
import { FileCredentialStore, type AgentCredentials, type CredentialStore } from "./credential-store.js";
import { RUST_CORE_VERSION } from "./native-core.js";
import { FileRuntimeStateStore, MemoryRuntimeStateStore, type AgentRuntimeState } from "./runtime-state-store.js";

class MemoryCredentials implements CredentialStore {
  constructor(public value?: AgentCredentials) {}
  async load(): Promise<AgentCredentials | undefined> { return this.value; }
  async save(credentials: AgentCredentials): Promise<void> { this.value = credentials; }
}

describe("published Node SDK surface", () => {
  let directory: string | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("loads the Rust core and secures persisted credentials", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-test-"));
    const path = join(directory, "credentials.json");
    const store = new FileCredentialStore("activation-token", path);
    const keys = generateIdentityKeys();
    const credentials = {
      sessionToken: "session-token",
      peer: {
        id: "00000000-0000-4000-8000-000000000001",
        type: "AGENT" as const,
        status: "ACTIVE" as const,
        handle: "@test.agent",
        displayName: "Test agent",
        publicDiscoverable: false,
        organizationDiscoverable: true,
        personalOwnerPeerId: "00000000-0000-4000-8000-000000000002",
        signingPublicKey: keys.signingPublicKey,
        encryptionPublicKey: keys.encryptionPublicKey,
      },
      keys,
    };

    expect(RUST_CORE_VERSION).toBe("0.1.0");
    await store.save(credentials);
    await expect(store.load()).resolves.toEqual(credentials);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("can reopen an explicit credential path without retaining an activation token", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-reopen-"));
    const path = join(directory, "credentials.json");
    const store = new FileCredentialStore(undefined, path);
    expect(store.path).toBe(path);
    const agent = new Agent({ credentialPath: path });
    expect(agent.connected).toBe(false);
    expect(agent.peer).toBeUndefined();
  });

  it("requires either a token or an explicit credential path", () => {
    expect(() => new FileCredentialStore()).toThrow("activation token or an explicit credential path");
  });

  it("keeps an authenticated runtime alive only through its current open socket", async () => {
    vi.useFakeTimers();
    const agent = new Agent({
      credentialStore: new MemoryCredentials(),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
    });
    const firstSocket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const replacementSocket = {
      readyState: 1,
      send: vi.fn(),
      close: vi.fn(),
    };
    const internals = agent as unknown as {
      stopped: boolean;
      ready: boolean;
      socket: typeof firstSocket;
      startHeartbeat(socket: typeof firstSocket): void;
    };
    internals.stopped = false;
    internals.ready = true;
    internals.socket = firstSocket;
    internals.startHeartbeat(firstSocket);

    await vi.advanceTimersByTimeAsync(25_000);
    expect(firstSocket.send).toHaveBeenCalledTimes(1);
    expect(firstSocket.send).toHaveBeenLastCalledWith(JSON.stringify({ kind: "PING" }));

    internals.socket = replacementSocket;
    internals.startHeartbeat(replacementSocket);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(firstSocket.send).toHaveBeenCalledTimes(1);
    expect(replacementSocket.send).toHaveBeenCalledTimes(1);

    replacementSocket.readyState = 2;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(replacementSocket.send).toHaveBeenCalledTimes(1);

    replacementSocket.readyState = 1;
    await agent.stop();
    await vi.advanceTimersByTimeAsync(75_000);
    expect(replacementSocket.send).toHaveBeenCalledTimes(1);
    expect(replacementSocket.close).toHaveBeenCalledWith(1000, "Agent stopped");
  });

  it("persists runtime state privately", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-runtime-state-"));
    const path = join(directory, "nested", "runtime.json");
    const store = new FileRuntimeStateStore(path);
    const state: AgentRuntimeState = {
      version: 1,
      outbox: [],
      inbox: [],
      processedIncoming: { "00000000-0000-4000-8000-000000000099": "READ" },
      counterparties: {},
      workroomCursors: {},
      processedWorkroomEvents: {},
      workroomEventFailures: {},
      workroomMandateUsage: {},
    };
    await store.save(state);
    await expect(store.load()).resolves.toEqual(state);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("retries activation after a lost response with the exact persisted request and keys", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-activation-replay-"));
    const credentialPath = join(directory, "credentials.json");
    const runtimeStatePath = join(directory, "runtime.json");
    const activationToken = "activation-token-that-is-long-enough-for-the-api";
    const bodies: Array<Record<string, string>> = [];
    let committedResponse: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      bodies.push(body);
      committedResponse ??= {
        token: "activation-access-token",
        accessToken: "activation-access-token",
        refreshToken: "activation-refresh-token",
        accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
        peer: {
          id: "00000000-0000-4000-8000-000000000091",
          type: "AGENT",
          status: "ACTIVE",
          handle: "@activation.replay",
          displayName: "Activation Replay",
          publicDiscoverable: false,
          organizationDiscoverable: true,
          personalOwnerPeerId: "00000000-0000-4000-8000-000000000092",
          signingPublicKey: body.signingPublicKey,
          encryptionPublicKey: body.encryptionPublicKey,
        },
      };
      if (bodies.length === 1) throw new Error("connection reset after activation committed");
      return new Response(JSON.stringify(committedResponse), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }));

    const first = new Agent({ token: activationToken, credentialPath, runtimeStatePath, supervision: false });
    await expect(first.start()).rejects.toThrow("connection reset after activation committed");
    const persistedAfterFailure = await readFile(runtimeStatePath, "utf8");
    expect(persistedAfterFailure).not.toContain(activationToken);
    expect(JSON.parse(persistedAfterFailure)).toMatchObject({
      pendingActivation: { requestId: expect.any(String), keys: { signingSecretKey: expect.any(String) } },
    });

    const restarted = new Agent({ token: activationToken, credentialPath, runtimeStatePath, supervision: false });
    (restarted as unknown as { connectWithRefresh(): Promise<void> }).connectWithRefresh = async () => undefined;
    await restarted.start();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(await new FileCredentialStore(undefined, credentialPath).load()).toMatchObject({
      accessToken: "activation-access-token",
      refreshToken: "activation-refresh-token",
      keys: {
        signingPublicKey: bodies[0]!.signingPublicKey,
        encryptionPublicKey: bodies[0]!.encryptionPublicKey,
      },
    });
    expect(JSON.parse(await readFile(runtimeStatePath, "utf8"))).not.toHaveProperty("pendingActivation");
  });

  it("re-pairs revoked persisted credentials with the same identity keys", async () => {
    const keys = generateIdentityKeys();
    const previous = {
      sessionToken: "revoked-access",
      accessToken: "revoked-access",
      refreshToken: "revoked-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      peer: testPeer("00000000-0000-4000-8000-000000000093", "@repair.keys", keys),
      keys,
    } satisfies AgentCredentials;
    const store = new MemoryCredentials(previous);
    const activationBodies: Array<Record<string, string>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/agent-runtime/session/refresh")) {
        return new Response(JSON.stringify({
          error: { code: "INVALID_REFRESH_TOKEN", message: "Agent credentials are invalid or expired" },
        }), { status: 401, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("/v1/agents/activate")) {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        activationBodies.push(body);
        return new Response(JSON.stringify({
          token: "repaired-access",
          accessToken: "repaired-access",
          refreshToken: "repaired-refresh",
          accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
          peer: {
            ...previous.peer,
            signingPublicKey: body.signingPublicKey,
            encryptionPublicKey: body.encryptionPublicKey,
          },
        }), { status: 201, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const agent = new Agent({
      token: "new-one-time-connection-code",
      credentialStore: store,
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
    });
    (agent as unknown as { connectWithRefresh(): Promise<void> }).connectWithRefresh = async () => undefined;

    await agent.start();

    expect(activationBodies).toHaveLength(1);
    expect(activationBodies[0]).toMatchObject({
      activationToken: "new-one-time-connection-code",
      signingPublicKey: keys.signingPublicKey,
      encryptionPublicKey: keys.encryptionPublicKey,
    });
    expect(store.value).toMatchObject({
      accessToken: "repaired-access",
      refreshToken: "repaired-refresh",
      keys,
    });
  });

  it("acks only after handler success and skips a confirmed redelivery", async () => {
    const agentKeys = generateIdentityKeys();
    const senderKeys = generateIdentityKeys();
    const agentPeer = testPeer("00000000-0000-4000-8000-000000000011", "@receiver.test", agentKeys);
    const sender = testPeer("00000000-0000-4000-8000-000000000012", "@sender.test", senderKeys);
    const credentials: AgentCredentials = { sessionToken: "session", peer: agentPeer, keys: agentKeys };
    const stateStore = new MemoryRuntimeStateStore();
    const agent = new Agent({
      credentialStore: new MemoryCredentials(credentials), runtimeStateStore: stateStore, supervision: false,
    });
    const frames: object[] = [];
    const requestedPaths: string[] = [];
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      ready: boolean;
      socket: { readyState: number; send(value: string): void };
      sentThisConnection: Set<string>;
      request: (path: string) => Promise<unknown>;
      handleFrame(frame: ServerFrame): Promise<void>;
      drainOutbox(): Promise<void>;
    };
    internals.credentials = credentials;
    internals.ready = true;
    internals.socket = { readyState: 1, send: (value) => frames.push(JSON.parse(value) as object) };
    internals.request = async (path) => {
      requestedPaths.push(path);
      return path === "/v1/messages/authorize" ? { recipient: sender } : sender;
    };
    let calls = 0;
    agent.on("message", async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary handler failure");
    });
    const envelope = encryptText({
      messageId: "00000000-0000-4000-8000-000000000013",
      conversationId: "00000000-0000-4000-8000-000000000014",
      senderPeerId: sender.id,
      recipientPeerId: agentPeer.id,
      timestamp: "2026-09-03T12:00:00.000Z",
      plaintext: "retry me",
      senderSigningSecretKey: senderKeys.signingSecretKey,
      senderEncryptionSecretKey: senderKeys.encryptionSecretKey,
      recipientEncryptionPublicKey: agentKeys.encryptionPublicKey,
    });
    const frame = serverFrameSchema.parse({ kind: "MESSAGE", envelope });

    await expect(internals.handleFrame(frame)).rejects.toThrow("temporary handler failure");
    expect(requestedPaths).toContain(`/v1/messages/${envelope.message_id}/sender-keys`);
    expect(frames).toEqual([]);
    expect((await stateStore.load())?.inbox.map((item) => item.message_id)).toEqual([envelope.message_id]);
    await internals.handleFrame(frame);
    await internals.handleFrame(frame);
    expect(calls).toBe(2);
    expect(frames).toEqual([
      { kind: "ACK", messageId: envelope.message_id, state: "DELIVERED" },
      { kind: "ACK", messageId: envelope.message_id, state: "DELIVERED" },
    ]);
    await internals.handleFrame(serverFrameSchema.parse({
      kind: "ACK_RECEIVED", messageId: envelope.message_id, state: "DELIVERED",
    }));
    expect((await stateStore.load())?.inbox).toEqual([]);

    const sent = await agent.sendWithDetails(sender.handle, "durable output");
    expect((await stateStore.load())?.outbox.map((item) => item.message_id)).toContain(sent.messageId);
    internals.sentThisConnection.clear();
    await internals.drainOutbox();
    expect(frames.filter((item) => (
      item as { kind?: string; envelope?: { message_id?: string } }
    ).envelope?.message_id === sent.messageId)).toHaveLength(2);
    await internals.handleFrame(serverFrameSchema.parse({
      kind: "RECEIPT", messageId: sent.messageId, state: "DELIVERED",
    }));
    expect((await stateStore.load())?.outbox).toEqual([]);
    expect(frames).toContainEqual({ kind: "RECEIPT_ACK", messageId: sent.messageId, state: "DELIVERED" });
  });

  it("relays an unmentioned supervisor only when the conversation has a counterparty", async () => {
    const agentKeys = generateIdentityKeys();
    const supervisorKeys = generateIdentityKeys();
    const counterpartyKeys = generateIdentityKeys();
    const agentPeer = testPeer("00000000-0000-4000-8000-000000000015", "@receiver.routing", agentKeys);
    const supervisor = {
      ...testPeer("00000000-0000-4000-8000-000000000016", "@owner.routing", supervisorKeys),
      type: "HUMAN" as const,
    };
    const counterparty = testPeer(
      "00000000-0000-4000-8000-000000000017", "@counterparty.routing", counterpartyKeys,
    );
    const credentials: AgentCredentials = { sessionToken: "session", peer: agentPeer, keys: agentKeys };
    const agent = new Agent({
      credentialStore: new MemoryCredentials(credentials),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: true,
    });
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      ready: boolean;
      socket: { readyState: number; send(value: string): void };
      supervisors: PublicPeer[];
      counterparties: Map<string, PublicPeer>;
      request: (path: string) => Promise<unknown>;
      handleFrame(frame: ServerFrame): Promise<void>;
    };
    internals.credentials = credentials;
    internals.ready = true;
    internals.socket = { readyState: 1, send: () => undefined };
    internals.supervisors = [supervisor];
    internals.request = async () => supervisor;
    const routing: Array<{ mode: "REPLY" | "RELAY"; targetHandle: string }> = [];
    agent.on("message", (message) => {
      routing.push(message.routing);
    });

    const deliverSupervisorMessage = async (messageId: string, conversationId: string) => {
      const envelope = encryptText({
        messageId,
        conversationId,
        senderPeerId: supervisor.id,
        recipientPeerId: agentPeer.id,
        timestamp: "2026-09-04T12:00:00.000Z",
        plaintext: "hello",
        senderSigningSecretKey: supervisorKeys.signingSecretKey,
        senderEncryptionSecretKey: supervisorKeys.encryptionSecretKey,
        recipientEncryptionPublicKey: agentKeys.encryptionPublicKey,
      });
      await internals.handleFrame(serverFrameSchema.parse({ kind: "MESSAGE", envelope }));
    };

    await deliverSupervisorMessage(
      "00000000-0000-4000-8000-000000000018",
      "00000000-0000-4000-8000-000000000019",
    );
    expect(routing[0]).toEqual({ mode: "REPLY", targetHandle: supervisor.handle });

    const supervisedConversationId = "00000000-0000-4000-8000-000000000020";
    internals.counterparties.set(supervisedConversationId, counterparty);
    await deliverSupervisorMessage("00000000-0000-4000-8000-000000000023", supervisedConversationId);
    expect(routing[1]).toEqual({ mode: "RELAY", targetHandle: counterparty.handle });
  });

  it("persists access and rotated refresh credentials through the issuer hook", async () => {
    const keys = generateIdentityKeys();
    const credentials: AgentCredentials = {
      sessionToken: "legacy",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      peer: testPeer("00000000-0000-4000-8000-000000000021", "@refresh.test", keys),
      keys,
    };
    const credentialStore = new MemoryCredentials(credentials);
    let reason: string | undefined;
    const agent = new Agent({
      credentialStore,
      runtimeStateStore: new MemoryRuntimeStateStore(),
      refreshCredentials: async (context) => {
        reason = context.reason;
        return {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          accessTokenExpiresAt: "2030-01-01T00:00:00.000Z",
        };
      },
    });
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      refreshCredentialsIfNeeded(reason: "EXPIRING"): Promise<boolean>;
    };
    internals.credentials = credentials;
    await expect(internals.refreshCredentialsIfNeeded("EXPIRING")).resolves.toBe(true);
    expect(reason).toBe("EXPIRING");
    expect(credentialStore.value).toMatchObject({
      sessionToken: "new-access", accessToken: "new-access", refreshToken: "new-refresh",
    });
  });

  it("automatically rotates expired aTalk credentials and reuses them after restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-refresh-"));
    const path = join(directory, "credentials.json");
    const keys = generateIdentityKeys();
    const credentialStore = new FileCredentialStore(undefined, path);
    await credentialStore.save({
      sessionToken: "access-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      peer: testPeer("00000000-0000-4000-8000-000000000022", "@automatic.refresh", keys),
      keys,
    });
    const receivedRefreshTokens: string[] = [];
    const receivedRequestIds: string[] = [];
    let rotation = 1;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { refreshToken: string; requestId: string };
      receivedRefreshTokens.push(body.refreshToken);
      receivedRequestIds.push(body.requestId);
      rotation += 1;
      return new Response(JSON.stringify({
        accessToken: `access-${rotation}`,
        refreshToken: `refresh-${rotation}`,
        expiresAt: "2020-01-01T00:00:00.000Z",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const first = new Agent({ credentialPath: path, baseUrl: "https://api.atalk.test", supervision: false });
    const firstInternals = first as unknown as {
      credentials: AgentCredentials;
      refreshCredentialsIfNeeded(reason: "EXPIRING"): Promise<boolean>;
    };
    firstInternals.credentials = (await credentialStore.load())!;
    await expect(firstInternals.refreshCredentialsIfNeeded("EXPIRING")).resolves.toBe(true);
    expect(await credentialStore.load()).toMatchObject({
      sessionToken: "access-2", accessToken: "access-2", refreshToken: "refresh-2",
    });

    const restartedStore = new FileCredentialStore(undefined, path);
    const restarted = new Agent({ credentialPath: path, baseUrl: "https://api.atalk.test", supervision: false });
    const restartedInternals = restarted as unknown as {
      credentials: AgentCredentials;
      refreshCredentialsIfNeeded(reason: "EXPIRING"): Promise<boolean>;
    };
    restartedInternals.credentials = (await restartedStore.load())!;
    await expect(restartedInternals.refreshCredentialsIfNeeded("EXPIRING")).resolves.toBe(true);
    expect(receivedRefreshTokens).toEqual(["refresh-1", "refresh-2"]);
    expect(receivedRequestIds).toHaveLength(2);
    expect(receivedRequestIds[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(receivedRequestIds[0]).not.toBe(receivedRequestIds[1]);
    expect(await restartedStore.load()).toMatchObject({
      sessionToken: "access-3", accessToken: "access-3", refreshToken: "refresh-3",
    });
  });

  it("reuses the persisted refresh request after a lost response and process restart", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-lost-refresh-"));
    const path = join(directory, "credentials.json");
    const keys = generateIdentityKeys();
    const store = new FileCredentialStore(undefined, path);
    await store.save({
      sessionToken: "lost-access",
      accessToken: "lost-access",
      refreshToken: "lost-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      peer: testPeer("00000000-0000-4000-8000-000000000024", "@lost.refresh", keys),
      keys,
    });
    const requestIds: string[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      requestIds.push(body.requestId);
      if (calls === 1) throw new TypeError("response lost");
      return new Response(JSON.stringify({
        accessToken: "recovered-access",
        refreshToken: "recovered-refresh",
        expiresAt: "2030-01-01T00:00:00.000Z",
      }), { status: 201, headers: { "content-type": "application/json" } });
    }));

    const first = new Agent({ credentialPath: path, baseUrl: "https://api.atalk.test", supervision: false });
    const firstInternals = first as unknown as {
      credentials: AgentCredentials;
      refreshCredentialsIfNeeded(reason: "EXPIRING"): Promise<boolean>;
    };
    firstInternals.credentials = (await store.load())!;
    await expect(firstInternals.refreshCredentialsIfNeeded("EXPIRING")).rejects.toThrow("response lost");
    expect((await store.load())?.refreshRequestId).toBe(requestIds[0]);

    const restarted = new Agent({ credentialPath: path, baseUrl: "https://api.atalk.test", supervision: false });
    const restartedInternals = restarted as unknown as {
      credentials: AgentCredentials;
      refreshCredentialsIfNeeded(reason: "EXPIRING"): Promise<boolean>;
    };
    restartedInternals.credentials = (await store.load())!;
    await expect(restartedInternals.refreshCredentialsIfNeeded("EXPIRING")).resolves.toBe(true);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(await store.load()).toMatchObject({
      accessToken: "recovered-access",
      refreshToken: "recovered-refresh",
    });
    expect((await store.load())?.refreshRequestId).toBeUndefined();
  });

  it("stops reconnecting when the persisted refresh token is expired", async () => {
    const keys = generateIdentityKeys();
    const credentials: AgentCredentials = {
      sessionToken: "expired-access",
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
      accessTokenExpiresAt: "2020-01-01T00:00:00.000Z",
      peer: testPeer("00000000-0000-4000-8000-000000000023", "@expired.refresh", keys),
      keys,
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: { code: "INVALID_REFRESH_TOKEN", message: "Agent credentials are invalid or expired" },
    }), { status: 401, headers: { "content-type": "application/json" } })));
    const agent = new Agent({
      credentialStore: new MemoryCredentials(credentials),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      baseUrl: "https://api.atalk.test",
      supervision: false,
    });
    const errors: Error[] = [];
    agent.on("error", (error) => errors.push(error));
    const scheduleReconnect = vi.fn();
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      stopped: boolean;
      recoverRejectedSession(): Promise<void>;
      scheduleReconnect(): void;
    };
    internals.credentials = credentials;
    internals.stopped = false;
    internals.scheduleReconnect = scheduleReconnect;

    await internals.recoverRejectedSession();

    expect(internals.stopped).toBe(true);
    expect(scheduleReconnect).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain("INVALID_REFRESH_TOKEN");
  });

  it("streams file attachments through the v2 chunk contract with progress", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-attachment-"));
    const filePath = join(directory, "invoice.txt");
    await writeFile(filePath, "invoice-42");
    const senderKeys = generateIdentityKeys();
    const recipientKeys = generateIdentityKeys();
    const sender = testPeer("00000000-0000-4000-8000-000000000031", "@agent.test", senderKeys);
    const recipient = testPeer("00000000-0000-4000-8000-000000000032", "@recipient.test", recipientKeys);
    const credentials: AgentCredentials = { sessionToken: "session", peer: sender, keys: senderKeys };
    const stateStore = new MemoryRuntimeStateStore();
    const agent = new Agent({ credentialStore: new MemoryCredentials(credentials), runtimeStateStore: stateStore, supervision: false });
    const uploaded = new Map<string, Uint8Array>();
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      request(path: string): Promise<unknown>;
      authorizedFetch(url: string, init?: RequestInit): Promise<Response>;
    };
    internals.credentials = credentials;
    internals.request = async () => ({ recipient });
    internals.authorizedFetch = async (url, init = {}) => {
      if (init.method === "HEAD") return new Response(null, { status: 404 });
      if (init.method === "POST") {
        uploaded.set(url.split("/attachments/")[1]!.split("?")[0]!, new Uint8Array(init.body as ArrayBuffer));
        return new Response("{}", { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 204 });
    };
    const progress: number[] = [];
    const sent = await agent.sendAttachmentFileWithDetails(recipient.handle, {
      path: filePath,
      transfer: { onProgress: ({ bytesTransferred }) => progress.push(bytesTransferred) },
    });
    const envelope = (await stateStore.load())!.outbox.find((item) => item.message_id === sent.messageId)!;
    const plaintext = decryptText({
      envelope,
      senderSigningPublicKey: sender.signingPublicKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      recipientEncryptionSecretKey: recipientKeys.encryptionSecretKey,
    });
    const attachment = decodeAttachmentMessage(plaintext)!.attachment;
    expect(attachment.version).toBe(2);
    if (attachment.version !== 2) throw new Error("Expected v2 descriptor");
    expect(new TextDecoder().decode(decryptAttachmentChunk(uploaded.get(attachment.id)!, attachment, 0))).toBe("invoice-42");
    expect(progress).toEqual([10]);
  });

  it("removes an unpublished chunk when an upload response is lost", async () => {
    directory = await mkdtemp(join(tmpdir(), "atalk-sdk-attachment-cleanup-"));
    const filePath = join(directory, "voice.m4a");
    await writeFile(filePath, "voice-data");
    const senderKeys = generateIdentityKeys();
    const recipientKeys = generateIdentityKeys();
    const sender = testPeer("00000000-0000-4000-8000-000000000041", "@agent.cleanup", senderKeys);
    const recipient = testPeer("00000000-0000-4000-8000-000000000042", "@recipient.cleanup", recipientKeys);
    const agent = new Agent({
      credentialStore: new MemoryCredentials({ sessionToken: "session", peer: sender, keys: senderKeys }),
      runtimeStateStore: new MemoryRuntimeStateStore(),
      supervision: false,
    });
    const deleted: string[] = [];
    const internals = agent as unknown as {
      credentials: AgentCredentials;
      request(path: string): Promise<unknown>;
      authorizedFetch(url: string, init?: RequestInit): Promise<Response>;
    };
    internals.credentials = { sessionToken: "session", peer: sender, keys: senderKeys };
    internals.request = async () => ({ recipient });
    internals.authorizedFetch = async (url, init = {}) => {
      if (init.method === "HEAD") return new Response(null, { status: 404 });
      if (init.method === "DELETE") {
        deleted.push(url.split("/attachments/")[1]!);
        return new Response(null, { status: 204 });
      }
      throw new Error("connection reset after commit");
    };

    await expect(agent.sendAttachmentFileWithDetails(recipient.handle, {
      path: filePath,
      transfer: { maxAttempts: 1 },
    })).rejects.toThrow("connection reset after commit");
    expect(deleted).toHaveLength(1);
  });
});

function testPeer(
  id: string,
  handle: string,
  keys: ReturnType<typeof generateIdentityKeys>,
): PublicPeer {
  return {
    id,
    type: "AGENT",
    status: "ACTIVE",
    handle,
    displayName: handle,
    publicDiscoverable: false,
    organizationDiscoverable: true,
    signingPublicKey: keys.signingPublicKey,
    encryptionPublicKey: keys.encryptionPublicKey,
  };
}
