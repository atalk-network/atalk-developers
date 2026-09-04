import type { IncomingMessage } from "@atalk/sdk";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAtalkGateway } from "./gateway.js";
import { FileGatewayInboxStore, GatewayInbox, MemoryGatewayInboxStore } from "./inbox.js";

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

class FakeAgent {
  constructor(private readonly workroomRole: "contributor" | "observer" = "contributor") {}

  connected = false;
  peer = {
    id: "00000000-0000-4000-8000-000000000001",
    type: "AGENT" as const,
    status: "ACTIVE" as const,
    handle: "@gateway.test",
    displayName: "Gateway test",
    publicDiscoverable: false,
    organizationDiscoverable: true,
    signingPublicKey: "signing",
    encryptionPublicKey: "encryption",
  };
  messageHandler?: MessageHandler;
  errorHandler?: ErrorHandler;
  sent: Array<{ to: string; text?: string; conversationId?: string; bytes?: number }> = [];
  workroomActions: Array<{ kind: string; input: Record<string, unknown> }> = [];
  workrooms = {
    list: async () => ({ workrooms: [{ workroom: { id: "00000000-0000-4000-8000-000000000010" } }], nextCursor: null }),
    get: async (id: string) => ({
      workroom: { id }, membership: { role: this.workroomRole },
      members: [], threads: [], latestMandates: [], approvals: [],
      events: [{ marker: "must-stay-private" }], nextAfterSequence: 9,
    }),
    poll: async (_id: string, handler: (event: {
      directedToMe: boolean;
      routing: { directedToMe: boolean };
      marker: string;
    }) => void) => {
      handler({ directedToMe: false, routing: { directedToMe: false }, marker: "general" });
      handler({ directedToMe: true, routing: { directedToMe: false }, marker: "inconsistent" });
      handler({ directedToMe: true, routing: { directedToMe: true }, marker: "targeted" });
      return 7;
    },
    readAuditEvents: async () => ({
      events: [
        { directedToMe: false, routing: { directedToMe: false }, marker: "general" },
        { directedToMe: true, routing: { directedToMe: true }, marker: "targeted" },
      ],
      nextAfterSequence: null,
    }),
    publish: async () => ({ event: { eventId: "00000000-0000-4000-8000-000000000011" } }),
    publishMandated: async (input: Record<string, unknown>) => {
      this.workroomActions.push({ kind: "publish", input });
      return { status: "executed", value: { event: { eventId: "00000000-0000-4000-8000-000000000011" } } };
    },
    submitFileMandated: async (input: Record<string, unknown>) => {
      this.workroomActions.push({ kind: "submit_file", input });
      return { status: "executed", value: { descriptor: { id: "00000000-0000-4000-8000-000000000012" } } };
    },
    downloadAttachmentToMandated: async (input: Record<string, unknown>) => {
      this.workroomActions.push({ kind: "read_file", input });
      await writeFile(String(input.path), new Uint8Array([7]));
      return { status: "executed", value: input.path };
    },
    guardMandateUse: async () => ({ status: "permitted" }),
    uploadAttachmentFile: async () => ({ id: "00000000-0000-4000-8000-000000000012" }),
    downloadAttachmentTo: async (_descriptor: unknown, path: string) => { await writeFile(path, new Uint8Array([9])); return path; },
  };

  on(event: "message" | "error", handler: MessageHandler | ErrorHandler): this {
    if (event === "message") this.messageHandler = handler as MessageHandler;
    else this.errorHandler = handler as ErrorHandler;
    return this;
  }

  async start(): Promise<void> { this.connected = true; }
  async stop(): Promise<void> { this.connected = false; }
  async sendWithDetails(to: string, text: string) {
    this.sent.push({ to, text });
    return { conversationId: "new-conversation", messageId: "new-message" };
  }
  async sendInConversation(to: string, text: string, conversationId: string) {
    this.sent.push({ to, text, conversationId });
    return "continued-message";
  }
  async sendAttachmentWithDetails(to: string, input: { data: Uint8Array }) {
    this.sent.push({ to, bytes: input.data.byteLength });
    return { conversationId: "attachment-conversation", messageId: "attachment-message" };
  }
  async sendAttachmentInConversation(to: string, input: { data: Uint8Array }, conversationId: string) {
    this.sent.push({ to, bytes: input.data.byteLength, conversationId });
    return "continued-attachment";
  }
  async sendAttachmentFileWithDetails(to: string, input: { path: string }) {
    this.sent.push({ to, bytes: (await readFile(input.path)).byteLength });
    return { conversationId: "attachment-conversation", messageId: "attachment-message" };
  }
  async sendAttachmentFileInConversation(to: string, input: { path: string }, conversationId: string) {
    this.sent.push({ to, bytes: (await readFile(input.path)).byteLength, conversationId });
    return "continued-attachment";
  }
  async markMessageRead() {}
  async downloadAttachment() { return new Uint8Array(); }

  emitMessage(message: IncomingMessage): void {
    void this.messageHandler?.(message);
  }
}

function incoming(overrides: Partial<IncomingMessage> = {}) {
  const calls = { reply: [] as string[], relay: [] as string[], read: 0 };
  const message: IncomingMessage = {
    id: "received-message",
    conversationId: "conversation",
    text: "hello",
    sender: {
      id: "00000000-0000-4000-8000-000000000002",
      type: "HUMAN",
      status: "ACTIVE",
      handle: "@human.test",
      displayName: "Human test",
      publicDiscoverable: false,
      organizationDiscoverable: true,
      signingPublicKey: "signing",
      encryptionPublicKey: "encryption",
    },
    receivedAt: new Date("2026-09-02T12:00:00.000Z"),
    isSupervisor: false,
    mentions: [],
    isMentioned: false,
    async reply(text) { calls.reply.push(text); return "reply-message"; },
    async replyAttachment() { return "reply-attachment"; },
    async replyAttachmentFile() { return "reply-file"; },
    async relay(text) { calls.relay.push(text); return "relay-message"; },
    async relayAttachment() { return "relay-attachment"; },
    async relayAttachmentFile() { return "relay-file"; },
    async markRead() { calls.read += 1; },
    routing: { mode: "REPLY", targetHandle: "@human.test" },
    ...overrides,
  };
  return { message, calls };
}

function asAgent(fake: FakeAgent) {
  return fake as unknown as import("@atalk/sdk").Agent;
}

describe("aTalk Gateway", () => {
  it("refuses an exposed listener without API authentication", () => {
    expect(() => createAtalkGateway({ host: "0.0.0.0", agent: asAgent(new FakeAgent()) }))
      .toThrow("ATALK_GATEWAY_API_KEY");
  });

  it("receives, replies, marks read and sends through the normalized API", async () => {
    const fake = new FakeAgent();
    const runtime = createAtalkGateway({
      host: "127.0.0.1",
      port: 0,
      agent: asAgent(fake),
      logger: { info() {}, error() {} },
    });
    await runtime.start();
    try {
      const health = await fetch(`${runtime.url}/health`).then((response) => response.json()) as { connected: boolean };
      expect(health.connected).toBe(true);

      const received = incoming();
      fake.emitMessage(received.message);
      const events = await fetch(`${runtime.url}/v1/events`).then((response) => response.json()) as {
        events: Array<{ type: string; data: { text: string }; actions: { reply: string } }>;
      };
      expect(events.events[0]).toMatchObject({ type: "message.received", data: { text: "hello" } });

      const replyResponse = await fetch(`${runtime.url}${events.events[0]!.actions.reply}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "world" }),
      });
      expect(replyResponse.status).toBe(201);
      expect(received.calls.reply).toEqual(["world"]);

      await fetch(`${runtime.url}/v1/messages/received-message/read`, { method: "POST" });
      expect(received.calls.read).toBe(1);

      const sent = await fetch(`${runtime.url}/v1/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to: "@someone", text: "hello there" }),
      });
      expect(sent.status).toBe(201);
      expect(fake.sent).toContainEqual({ to: "@someone", text: "hello there" });
    } finally {
      await runtime.stop();
    }
  });

  it("downloads and sends encrypted attachment payloads through the SDK boundary", async () => {
    const fake = new FakeAgent();
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, agent: asAgent(fake) });
    await runtime.start();
    try {
      const received = incoming({
        attachment: {
          descriptor: {
            version: 1,
            id: "00000000-0000-4000-8000-000000000003",
            kind: "IMAGE",
            name: "photo.png",
            mimeType: "image/png",
            size: 3,
            ciphertextSize: 19,
            key: "key",
            nonce: "nonce",
          },
          async download() { return new Uint8Array([1, 2, 3]); },
          async downloadTo(path) { await writeFile(path, new Uint8Array([1, 2, 3])); return path; },
        },
      });
      fake.emitMessage(received.message);
      const downloaded = await fetch(`${runtime.url}/v1/messages/received-message/attachment`);
      expect(downloaded.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

      const sent = await fetch(`${runtime.url}/v1/send/attachment?to=%40someone&name=voice.m4a`, {
        method: "POST",
        headers: { "content-type": "audio/mp4" },
        body: new Uint8Array([4, 5, 6]),
      });
      expect(sent.status).toBe(201);
      expect(fake.sent).toContainEqual({ to: "@someone", bytes: 3 });
    } finally {
      await runtime.stop();
    }
  });

  it("answers an explicitly mentioned supervisor privately and preserves legacy relay behavior", async () => {
    const fake = new FakeAgent();
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, agent: asAgent(fake) });
    await runtime.start();
    try {
      const targeted = incoming({ isSupervisor: true, isMentioned: true, mentions: [{
        peerId: "00000000-0000-4000-8000-000000000004", handle: "@agent.test", type: "AGENT",
      }] });
      fake.emitMessage(targeted.message);
      const targetedEvent = await fetch(`${runtime.url}/v1/events`).then((response) => response.json()) as {
        events: Array<{ actions: { reply: string } }>;
      };
      await fetch(`${runtime.url}${targetedEvent.events[0]!.actions.reply}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "private" }),
      });
      expect(targeted.calls.reply).toEqual(["private"]);
      expect(targeted.calls.relay).toEqual([]);

      const legacy = incoming({ id: "legacy-supervisor", isSupervisor: true });
      fake.emitMessage(legacy.message);
      const legacyEvent = await fetch(`${runtime.url}/v1/events`).then((response) => response.json()) as {
        events: Array<{ actions: { reply: string } }>;
      };
      await fetch(`${runtime.url}${legacyEvent.events[0]!.actions.reply}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "relay" }),
      });
      expect(legacy.calls.relay).toEqual(["relay"]);
    } finally {
      await runtime.stop();
    }
  });

  it("authenticates an explicitly exposed API", async () => {
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, apiKey: "secret", agent: asAgent(new FakeAgent()) });
    await runtime.start();
    try {
      expect((await fetch(`${runtime.url}/v1/events`)).status).toBe(401);
      expect((await fetch(`${runtime.url}/v1/events`, { headers: { authorization: "Bearer secret" } })).status).toBe(200);
    } finally {
      await runtime.stop();
    }
  });

  it("exposes only directed Workroom events by default and keeps an explicit audit view", async () => {
    const runtime = createAtalkGateway({
      host: "127.0.0.1",
      port: 0,
      allowWorkroomAudit: true,
      agent: asAgent(new FakeAgent()),
    });
    await runtime.start();
    try {
      const listed = await fetch(`${runtime.url}/v1/workrooms`).then((response) => response.json()) as {
        workrooms: Array<{ workroom: { id: string } }>;
      };
      const id = listed.workrooms[0]!.workroom.id;
      const opened = await fetch(`${runtime.url}/v1/workrooms/${id}`).then((response) => response.json()) as Record<string, unknown>;
      expect(opened).not.toHaveProperty("events");
      expect(opened).not.toHaveProperty("nextAfterSequence");
      const received = await fetch(`${runtime.url}/v1/workrooms/${id}/events`).then((response) => response.json()) as {
        events: Array<{ directedToMe: boolean; marker: string }>;
        cursor: number;
        scope: string;
      };
      expect(received).toEqual({
        events: [{ directedToMe: true, routing: { directedToMe: true }, marker: "targeted" }],
        cursor: 7,
        scope: "directed",
      });

      const audit = await fetch(`${runtime.url}/v1/workrooms/${id}/events?scope=audit&afterSequence=0`)
        .then((response) => response.json()) as { events: Array<{ marker: string }> };
      expect(audit.events.map(({ marker }) => marker)).toEqual(["general", "targeted"]);

      expect((await fetch(`${runtime.url}/v1/workrooms/${id}/events?scope=everything`)).status).toBe(400);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps complete Workroom audit disabled without operator opt-in", async () => {
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, agent: asAgent(new FakeAgent()) });
    await runtime.start();
    try {
      const opened = await fetch(`${runtime.url}/v1/workrooms/00000000-0000-4000-8000-000000000010`)
        .then((response) => response.json()) as Record<string, unknown>;
      expect(opened).not.toHaveProperty("events");
      expect(opened).not.toHaveProperty("nextAfterSequence");
      const response = await fetch(
        `${runtime.url}/v1/workrooms/00000000-0000-4000-8000-000000000010/events?scope=audit&afterSequence=0`,
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "WORKROOM_AUDIT_DISABLED",
        },
      });
    } finally {
      await runtime.stop();
    }
  });

  it("denies unsafe Workroom I/O and omits it from OpenAPI by default", async () => {
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, agent: asAgent(new FakeAgent()) });
    await runtime.start();
    const workroomId = "00000000-0000-4000-8000-000000000010";
    const threadId = "00000000-0000-4000-8000-000000000020";
    try {
      const attempts = [
        fetch(`${runtime.url}/v1/workrooms/${workroomId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ threadId, payload: { version: 1, kind: "message" } }),
        }),
        fetch(`${runtime.url}/v1/workrooms/${workroomId}/attachments?name=raw.txt`, {
          method: "POST", headers: { "content-type": "text/plain" }, body: "raw",
        }),
        fetch(`${runtime.url}/v1/workrooms/${workroomId}/attachments/download`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ descriptor: { id: "id", name: "raw.txt", mimeType: "text/plain", size: 1 } }),
        }),
      ];
      for (const attempt of attempts) {
        const response = await attempt;
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          error: { code: "UNSAFE_WORKROOM_IO_DISABLED" },
        });
      }

      const specification = await fetch(`${runtime.url}/openapi.json`).then((response) => response.json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(specification.paths[`/v1/workrooms/{workroomId}/events`]).not.toHaveProperty("post");
      expect(specification.paths).not.toHaveProperty("/v1/workrooms/{workroomId}/attachments");
      expect(specification.paths).not.toHaveProperty("/v1/workrooms/{workroomId}/attachments/download");
      expect(specification.paths).toHaveProperty("/v1/workrooms/{workroomId}/execute");
      expect(specification.paths).toHaveProperty("/v1/workrooms/{workroomId}/attachments/submit");
      expect(specification.paths).toHaveProperty("/v1/workrooms/{workroomId}/attachments/read");
    } finally {
      await runtime.stop();
    }
  });

  it("exposes unsafe Workroom compatibility I/O only with explicit opt-in", async () => {
    const runtime = createAtalkGateway({
      host: "127.0.0.1", port: 0, allowUnsafeWorkroomIo: true, agent: asAgent(new FakeAgent()),
    });
    await runtime.start();
    const workroomId = "00000000-0000-4000-8000-000000000010";
    const threadId = "00000000-0000-4000-8000-000000000020";
    try {
      const publication = await fetch(`${runtime.url}/v1/workrooms/${workroomId}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          payload: { version: 1, kind: "message", threadId, body: "manual", mentions: [] },
        }),
      });
      expect(publication.status).toBe(201);

      const upload = await fetch(`${runtime.url}/v1/workrooms/${workroomId}/attachments?name=raw.txt`, {
        method: "POST", headers: { "content-type": "text/plain" }, body: "x",
      });
      expect(upload.status).toBe(201);

      const download = await fetch(`${runtime.url}/v1/workrooms/${workroomId}/attachments/download`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ descriptor: { id: "id", name: "raw.txt", mimeType: "text/plain", size: 1 } }),
      });
      expect(download.status).toBe(200);
      expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array([9]));

      const specification = await fetch(`${runtime.url}/openapi.json`).then((response) => response.json()) as {
        paths: Record<string, Record<string, unknown>>;
      };
      expect(specification.paths[`/v1/workrooms/{workroomId}/events`]).toHaveProperty("post");
      expect(specification.paths).toHaveProperty("/v1/workrooms/{workroomId}/attachments");
      expect(specification.paths).toHaveProperty("/v1/workrooms/{workroomId}/attachments/download");
    } finally {
      await runtime.stop();
    }
  });

  it("does not discard a poll result when a separately read role is stale", async () => {
    const runtime = createAtalkGateway({
      host: "127.0.0.1", port: 0, agent: asAgent(new FakeAgent("observer")),
    });
    await runtime.start();
    try {
      const response = await fetch(
        `${runtime.url}/v1/workrooms/00000000-0000-4000-8000-000000000010/events`,
      ).then((value) => value.json());
      expect(response).toEqual({
        events: [{ directedToMe: true, routing: { directedToMe: true }, marker: "targeted" }],
        cursor: 7,
        scope: "directed",
      });
    } finally {
      await runtime.stop();
    }
  });

  it("executes Task publications and file I/O through the mandate boundary", async () => {
    const fake = new FakeAgent();
    const runtime = createAtalkGateway({ host: "127.0.0.1", port: 0, agent: asAgent(fake) });
    await runtime.start();
    const workroomId = "00000000-0000-4000-8000-000000000010";
    const threadId = "00000000-0000-4000-8000-000000000020";
    try {
      const publication = await fetch(`${runtime.url}/v1/workrooms/${workroomId}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          operationId: "00000000-0000-4000-8000-000000000030",
          payload: { version: 1, kind: "message", threadId, body: "Done", mentions: [] },
        }),
      });
      expect(publication.status).toBe(201);

      const submitted = await fetch(
        `${runtime.url}/v1/workrooms/${workroomId}/attachments/submit?threadId=${threadId}&operationId=00000000-0000-4000-8000-000000000031&name=result.txt`,
        { method: "POST", headers: { "content-type": "text/plain" }, body: "result" },
      );
      expect(submitted.status).toBe(201);

      const read = await fetch(`${runtime.url}/v1/workrooms/${workroomId}/attachments/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          threadId,
          operationId: "00000000-0000-4000-8000-000000000032",
          descriptor: {
            version: 1,
            id: "00000000-0000-4000-8000-000000000040",
            kind: "FILE",
            name: "result.txt",
            mimeType: "text/plain",
            size: 1,
            ciphertextSize: 17,
            key: "key",
            nonce: "nonce",
          },
        }),
      });
      expect(read.status).toBe(200);
      expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([7]));
      expect(fake.workroomActions.map(({ kind }) => kind).sort()).toEqual(["publish", "read_file", "submit_file"]);
    } finally {
      await runtime.stop();
    }
  });

  it("keeps explicit-poll events durable until the consumer acknowledges them", async () => {
    const inboxStore = new MemoryGatewayInboxStore();
    const firstAgent = new FakeAgent();
    const first = createAtalkGateway({
      host: "127.0.0.1", port: 0, agent: asAgent(firstAgent), inboxStore,
    });
    await first.start();
    const received = incoming();
    firstAgent.emitMessage(received.message);
    await expect.poll(() => first.inbox.pending).toBe(1);
    const firstPoll = await fetch(`${first.url}/v1/events?mode=explicit`).then((response) => response.json()) as {
      events: Array<{ id: string; actions: { ack: string } }>;
      pendingEvents: number;
    };
    expect(firstPoll.events[0]?.id).toBe(received.message.id);
    expect(firstPoll.pendingEvents).toBe(1);
    await first.stop();

    const secondAgent = new FakeAgent();
    const second = createAtalkGateway({
      host: "127.0.0.1", port: 0, agent: asAgent(secondAgent), inboxStore,
    });
    await second.start();
    try {
      const replay = await fetch(`${second.url}/v1/events?mode=explicit`).then((response) => response.json()) as {
        events: Array<{ actions: { ack: string; reply: string } }>;
      };
      const event = replay.events[0]!;
      const reply = await fetch(`${second.url}${event.actions.reply}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "after restart" }),
      });
      expect(reply.status).toBe(201);
      expect(secondAgent.sent).toContainEqual({
        to: "@human.test", text: "after restart", conversationId: "conversation",
      });
      expect((await fetch(`${second.url}${event.actions.ack}`, { method: "POST" })).status).toBe(200);
      const empty = await fetch(`${second.url}/v1/events?mode=explicit`).then((response) => response.json()) as {
        events: unknown[]; pendingEvents: number;
      };
      expect(empty).toEqual({ events: [], pendingEvents: 0 });
    } finally {
      await second.stop();
    }
  });

  it("persists the gateway inbox with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atalk-gateway-inbox-"));
    const path = join(directory, "nested", "inbox.json");
    try {
      const inbox = new GatewayInbox(10, new FileGatewayInboxStore(path));
      await inbox.push(incoming().message);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      const reopened = new GatewayInbox(10, new FileGatewayInboxStore(path));
      await reopened.initialize();
      expect(reopened.pending).toBe(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("signs webhooks and applies a synchronous text response", async () => {
    let signature: string | undefined;
    let eventType: string | undefined;
    const webhook = createServer((request, response) => {
      signature = request.headers["x-atalk-signature"] as string | undefined;
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        eventType = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { type: string }).type;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ markRead: true, reply: { text: "automated" } }));
      });
    });
    await new Promise<void>((resolve) => webhook.listen(0, "127.0.0.1", resolve));
    const address = webhook.address();
    if (!address || typeof address === "string") throw new Error("Webhook did not start");

    const fake = new FakeAgent();
    const runtime = createAtalkGateway({
      host: "127.0.0.1",
      port: 0,
      agent: asAgent(fake),
      webhookUrl: `http://127.0.0.1:${address.port}`,
      webhookSecret: "webhook-secret",
      webhookRetries: 1,
    });
    await runtime.start();
    try {
      const received = incoming();
      fake.emitMessage(received.message);
      await expect.poll(() => received.calls.reply).toEqual(["automated"]);
      expect(received.calls.read).toBe(1);
      expect(eventType).toBe("message.received");
      expect(signature).toMatch(/^sha256=[a-f0-9]{64}$/u);
    } finally {
      await runtime.stop();
      await new Promise<void>((resolve, reject) => webhook.close((error) => error ? reject(error) : resolve()));
    }
  });
});
