import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type IncomingMessage } from "@atalk/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentInbox, serializeMessage } from "./inbox.js";

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export interface AtalkMcpOptions {
  token?: string;
  baseUrl?: string;
  credentialPath?: string;
  agent?: Agent;
}

export interface AtalkMcpRuntime {
  server: McpServer;
  agent: Agent;
  inbox: AgentInbox;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAtalkMcpServer(options: AtalkMcpOptions = {}): AtalkMcpRuntime {
  const token = options.token ?? process.env.ATALK_AGENT_TOKEN;
  const agent = options.agent ?? new Agent({
    ...(token ? { token } : {}),
    baseUrl: options.baseUrl ?? process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath: options.credentialPath
      ?? process.env.ATALK_CREDENTIAL_PATH
      ?? join(process.env.PLUGIN_DATA ?? join(homedir(), ".atalk"), "mcp-agent.json"),
  });
  const inbox = new AgentInbox();
  const server = new McpServer({ name: "atalk", version: "0.1.0-alpha.5" });

  agent.on("message", (message: IncomingMessage) => inbox.push(message));
  agent.on("error", (error) => console.error(`[aTalk] ${error.message}`));

  server.registerTool(
    "atalk_status",
    { description: "Show the active aTalk identity, connection state, and queued message count." },
    async () => textResult({ connected: agent.connected, peer: agent.peer ?? null, pendingMessages: inbox.pending }),
  );

  server.registerTool(
    "atalk_receive",
    {
      description: "Receive queued encrypted aTalk messages. Optionally wait briefly when the inbox is empty.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(50).default(10),
        waitSeconds: z.number().int().min(0).max(25).default(0),
        markRead: z.boolean().default(true),
      }),
    },
    async ({ limit, waitSeconds, markRead }) => {
      const messages = await inbox.take(limit, waitSeconds);
      if (markRead) await Promise.all(messages.map((message) => message.markRead()));
      return textResult({ messages: messages.map(serializeMessage), pendingMessages: inbox.pending });
    },
  );

  server.registerTool(
    "atalk_send",
    {
      description: "Start an encrypted aTalk conversation with a human or agent handle.",
      inputSchema: z.object({
        handle: z.string().min(2).max(100).describe("Recipient handle, for example @sales.company"),
        text: z.string().min(1).max(32_000),
      }),
    },
    async ({ handle, text }) => textResult(await agent.sendWithDetails(handle, text)),
  );

  server.registerTool(
    "atalk_reply",
    {
      description: "Reply to a previously received aTalk message, preserving its encrypted conversation.",
      inputSchema: z.object({
        messageId: z.string().uuid(),
        text: z.string().min(1).max(32_000),
      }),
    },
    async ({ messageId, text }) => {
      const message = inbox.get(messageId);
      if (!message) throw new Error(`Unknown or expired aTalk message id: ${messageId}`);
      return textResult({ messageId: await message.reply(text), conversationId: message.conversationId });
    },
  );

  server.registerTool(
    "atalk_send_in_conversation",
    {
      description: "Send a message inside a known encrypted aTalk conversation.",
      inputSchema: z.object({
        handle: z.string().min(2).max(100),
        conversationId: z.string().uuid(),
        text: z.string().min(1).max(32_000),
      }),
    },
    async ({ handle, conversationId, text }) => textResult({
      messageId: await agent.sendInConversation(handle, text, conversationId),
      conversationId,
    }),
  );

  server.registerTool(
    "atalk_mark_read",
    {
      description: "Mark a previously received aTalk message as read.",
      inputSchema: z.object({ messageId: z.string().uuid() }),
    },
    async ({ messageId }) => {
      const message = inbox.get(messageId);
      if (!message) throw new Error(`Unknown or expired aTalk message id: ${messageId}`);
      await message.markRead();
      return textResult({ messageId, state: "READ" });
    },
  );

  server.registerTool(
    "atalk_relay_supervision",
    {
      description: "Relay an owner's intervention received through an aTalk supervised conversation.",
      inputSchema: z.object({
        messageId: z.string().uuid(),
        text: z.string().min(1).max(32_000),
      }),
    },
    async ({ messageId, text }) => {
      const message = inbox.get(messageId);
      if (!message) throw new Error(`Unknown or expired aTalk message id: ${messageId}`);
      if (!message.isSupervisor) throw new Error("The selected message is not a supervisor intervention");
      return textResult({ messageId: await message.relay(text), conversationId: message.conversationId });
    },
  );

  return {
    server,
    agent,
    inbox,
    start: () => agent.start(),
    stop: () => agent.stop(),
  };
}
