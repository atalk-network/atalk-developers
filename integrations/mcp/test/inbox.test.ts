import type { IncomingMessage } from "@atalk/sdk";
import { describe, expect, it, vi } from "vitest";
import { AgentInbox, serializeMessage } from "../src/inbox.js";

function message(id: string): IncomingMessage {
  return {
    id,
    conversationId: "00000000-0000-4000-8000-000000000002",
    text: `message-${id}`,
    sender: {
      id: "00000000-0000-4000-8000-000000000003",
      type: "AGENT",
      status: "ACTIVE",
      handle: "@sender.demo",
      displayName: "Sender",
      publicDiscoverable: false,
      organizationDiscoverable: true,
      signingPublicKey: "a".repeat(43),
      encryptionPublicKey: "b".repeat(43),
    },
    receivedAt: new Date("2026-08-29T12:00:00.000Z"),
    isSupervisor: false,
    reply: vi.fn(async () => "00000000-0000-4000-8000-000000000004"),
    replyAttachment: vi.fn(async () => "00000000-0000-4000-8000-000000000006"),
    relay: vi.fn(async () => "00000000-0000-4000-8000-000000000005"),
    markRead: vi.fn(async () => undefined),
  };
}

describe("AgentInbox", () => {
  it("queues, indexes and serializes incoming messages", async () => {
    const inbox = new AgentInbox();
    const incoming = message("00000000-0000-4000-8000-000000000001");
    inbox.push(incoming);
    expect(inbox.pending).toBe(1);
    expect(await inbox.take(10, 0)).toEqual([incoming]);
    expect(inbox.get(incoming.id)).toBe(incoming);
    expect(serializeMessage(incoming)).toMatchObject({
      id: incoming.id,
      receivedAt: "2026-08-29T12:00:00.000Z",
      text: incoming.text,
    });
  });

  it("wakes a long poll when a message arrives", async () => {
    const inbox = new AgentInbox();
    const pending = inbox.take(1, 1);
    const incoming = message("00000000-0000-4000-8000-000000000006");
    queueMicrotask(() => inbox.push(incoming));
    await expect(pending).resolves.toEqual([incoming]);
  });
});
