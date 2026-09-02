import type { Agent } from "@atalk/sdk";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAtalkMcpServer } from "../src/server.js";

describe("aTalk MCP server", () => {
  const closeables: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(closeables.splice(0).map((value) => value.close()));
  });

  it("negotiates MCP 2.0 and exposes the complete messaging surface", async () => {
    const fakeAgent = {
      connected: true,
      peer: { id: "peer-demo", handle: "@integration.demo", displayName: "Integration demo" },
      on: vi.fn().mockReturnThis(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendWithDetails: vi.fn().mockResolvedValue({ conversationId: "conversation", messageId: "message" }),
      sendInConversation: vi.fn().mockResolvedValue("message"),
    } as unknown as Agent;
    const runtime = createAtalkMcpServer({ agent: fakeAgent });
    const client = new Client({ name: "atalk-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(client, runtime.server);

    await runtime.start();
    await Promise.all([
      runtime.server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name).sort()).toEqual([
      "atalk_download_attachment",
      "atalk_mark_read",
      "atalk_receive",
      "atalk_relay_supervision",
      "atalk_reply",
      "atalk_reply_attachment",
      "atalk_save_attachment",
      "atalk_send",
      "atalk_send_attachment",
      "atalk_send_in_conversation",
      "atalk_status",
    ]);

    const status = await client.callTool({ name: "atalk_status", arguments: {} });
    expect(status.content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("@integration.demo") }),
    ]);
  });
});
