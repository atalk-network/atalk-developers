import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { createAtalkMcpServer, type AtalkMcpRuntime } from "./server.js";

class FakeAgent {
  connected = true;
  peer = { id: "11111111-1111-4111-8111-111111111111", handle: "@agent.test" };
  publications: unknown[] = [];
  workrooms = {
    list: async () => ({ workrooms: [], nextCursor: null }),
    get: async (workroomId: string) => ({
      workroom: { id: workroomId, status: "executing" },
      descriptor: { version: 1, objective: "Prepare the launch brief" },
      membership: { role: "contributor", joinedAt: "2026-09-03T00:00:00.000Z" },
      members: [], threads: [], latestMandates: [], approvals: [],
    }),
    poll: async (_workroomId: string, handler: (event: ReturnType<typeof workroomEvent>) => void) => {
      handler(workroomEvent(false, "general"));
      handler(workroomEvent(true, "targeted"));
      return 2;
    },
    readAuditEvents: async () => ({
      events: [workroomEvent(false, "general"), workroomEvent(true, "targeted")],
      nextAfterSequence: null,
    }),
    publishMandated: async (input: unknown) => {
      this.publications.push(input);
      return { status: "executed", value: { event: { eventId: "22222222-2222-4222-8222-222222222222" } } };
    },
  };
  on(): this { return this; }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

describe("aTalk MCP Task tools", () => {
  let runtime: AtalkMcpRuntime | undefined;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    await runtime?.server.close();
  });

  it("exposes permission-aware task tools and routes messages through the execution boundary", async () => {
    const agent = new FakeAgent();
    runtime = createAtalkMcpServer({ agent: agent as unknown as import("@atalk/sdk").Agent });
    client = new Client({ name: "atalk-mcp-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "atalk_workroom_message",
      "atalk_workroom_open",
      "atalk_workroom_audit",
      "atalk_workroom_plan",
      "atalk_workroom_deliverable",
      "atalk_workroom_submit_file",
      "atalk_workroom_read_attachment",
    ]));

    const opened = await client.callTool({
      name: "atalk_workroom_open",
      arguments: { workroomId: "33333333-3333-4333-8333-333333333333" },
    });
    expect(opened.isError).not.toBe(true);
    expect(JSON.stringify(opened.content)).toContain("Prepare the launch brief");

    const received = await client.callTool({
      name: "atalk_workroom_receive",
      arguments: { workroomId: "33333333-3333-4333-8333-333333333333", limit: 100 },
    });
    expect(JSON.stringify(received.content)).toContain("targeted");
    expect(JSON.stringify(received.content)).not.toContain("general");

    const audited = await client.callTool({
      name: "atalk_workroom_audit",
      arguments: {
        workroomId: "33333333-3333-4333-8333-333333333333",
        afterSequence: 0,
        limit: 100,
      },
    });
    expect(JSON.stringify(audited.content)).toContain("targeted");
    expect(JSON.stringify(audited.content)).toContain("general");

    const result = await client.callTool({
      name: "atalk_workroom_message",
      arguments: {
        workroomId: "33333333-3333-4333-8333-333333333333",
        threadId: "44444444-4444-4444-8444-444444444444",
        operationId: "55555555-5555-4555-8555-555555555555",
        body: "Listo para revisión",
        mentions: [{
          peerId: "66666666-6666-4666-8666-666666666666",
          handle: "@owner.test",
          peerType: "HUMAN",
          intent: "direct",
        }],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(agent.publications).toEqual([expect.objectContaining({
      operationId: "55555555-5555-4555-8555-555555555555",
      payload: expect.objectContaining({
        kind: "message",
        body: "Listo para revisión",
        mentions: [expect.objectContaining({ peerId: "66666666-6666-4666-8666-666666666666" })],
      }),
    })]);
  });
});

function workroomEvent(directedToMe: boolean, body: string) {
  return {
    sequence: body === "general" ? 1 : 2,
    event: {
      eventId: body === "general"
        ? "77777777-7777-4777-8777-777777777771"
        : "77777777-7777-4777-8777-777777777772",
      workroomId: "33333333-3333-4333-8333-333333333333",
      threadId: "44444444-4444-4444-8444-444444444444",
      actorPeerId: "88888888-8888-4888-8888-888888888888",
      kind: "message" as const,
      createdAt: "2026-09-03T00:00:00.000Z",
    },
    actor: { id: "88888888-8888-4888-8888-888888888888", handle: "@owner.test", type: "HUMAN" as const },
    content: {
      version: 1 as const,
      kind: "message" as const,
      threadId: "44444444-4444-4444-8444-444444444444",
      body,
      mentions: directedToMe ? [{
        peerId: "11111111-1111-4111-8111-111111111111",
        handle: "@agent.test",
        peerType: "AGENT" as const,
        intent: "direct" as const,
      }] : [],
    },
    routing: {
      directedToMe,
      directMentions: directedToMe ? [{
        peerId: "11111111-1111-4111-8111-111111111111",
        handle: "@agent.test",
        peerType: "AGENT" as const,
        intent: "direct" as const,
      }] : [],
      assignedSteps: [],
    },
    directedToMe,
  };
}
