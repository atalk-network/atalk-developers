import type { IncomingMessage } from "@atalk/sdk";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createAtalkGateway } from "./gateway.js";

type MessageHandler = (message: IncomingMessage) => void | Promise<void>;
type ErrorHandler = (error: Error) => void;

class FakeAgent {
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
          async downloadTo(path) { return path; },
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
