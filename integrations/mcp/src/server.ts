import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Agent, type IncomingMessage } from "@atalk/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentInbox, serializeMessage } from "./inbox.js";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_INLINE_BYTES = 20 * 1024 * 1024;

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

export interface AtalkMcpOptions {
  token?: string;
  baseUrl?: string;
  credentialPath?: string;
  attachmentDirectory?: string;
  allowedFileRoots?: string[];
  agent?: Agent;
}

export interface AtalkMcpRuntime {
  server: McpServer;
  agent: Agent;
  inbox: AgentInbox;
  start(): Promise<void>;
  stop(): Promise<void>;
}

function getMessage(inbox: AgentInbox, messageId: string): IncomingMessage {
  const message = inbox.get(messageId);
  if (!message) throw new Error(`Unknown or expired aTalk message id: ${messageId}`);
  return message;
}

function safeName(name: string): string {
  return basename(name).replace(/[^\p{L}\p{N}._ -]+/gu, "_").slice(0, 180) || "attachment";
}

function isWithin(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function readAllowedFile(filePath: string, roots: string[]): Promise<{ bytes: Uint8Array; name: string }> {
  const path = await realpath(resolve(filePath));
  const allowed = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))));
  if (!allowed.some((root) => isWithin(root, path))) throw new Error("File path is outside the configured aTalk MCP roots");
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Attachment path must be a regular file");
  if (metadata.size > MAX_ATTACHMENT_BYTES) throw new Error("aTalk attachments cannot exceed 100 MB");
  return { bytes: new Uint8Array(await readFile(path)), name: basename(path) };
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
  const attachmentDirectory = resolve(
    options.attachmentDirectory
      ?? process.env.ATALK_ATTACHMENT_DIR
      ?? join(process.env.PLUGIN_DATA ?? join(homedir(), ".atalk"), "mcp-attachments"),
  );
  const configuredRoots = process.env.ATALK_ALLOWED_FILE_ROOTS?.split(delimiter).filter(Boolean) ?? [];
  const allowedFileRoots = (options.allowedFileRoots ?? [process.cwd(), attachmentDirectory, ...configuredRoots])
    .map((root) => resolve(root));
  const inlineLimit = Math.min(
    MAX_ATTACHMENT_BYTES,
    Number.parseInt(process.env.ATALK_MCP_INLINE_MAX_BYTES ?? "", 10) || DEFAULT_INLINE_BYTES,
  );
  const inbox = new AgentInbox();
  const server = new McpServer({ name: "atalk", version: "0.1.0-alpha.9" });
  agent.on("message", (message) => inbox.push(message));
  agent.on("error", (error) => console.error(`[aTalk] ${error.message}`));

  server.registerTool("atalk_status", {
    description: "Show the active aTalk identity, connection state, and queued message count.",
  }, async () => textResult({ connected: agent.connected, peer: agent.peer ?? null, pendingMessages: inbox.pending }));

  server.registerTool("atalk_receive", {
    description: "Receive queued encrypted aTalk text and attachment metadata. Use atalk_download_attachment to inspect media bytes.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(50).default(10),
      waitSeconds: z.number().int().min(0).max(25).default(0),
      markRead: z.boolean().default(true),
    }),
  }, async ({ limit, waitSeconds, markRead }) => {
    const messages = await inbox.take(limit, waitSeconds);
    if (markRead) await Promise.all(messages.map((message) => message.markRead()));
    return textResult({ messages: messages.map(serializeMessage), pendingMessages: inbox.pending });
  });

  server.registerTool("atalk_download_attachment", {
    description: "Decrypt an attachment from a received message and return it as native MCP image/audio/resource content.",
    inputSchema: z.object({ messageId: z.string().uuid() }),
  }, async ({ messageId }) => {
    const message = getMessage(inbox, messageId);
    if (!message.attachment) throw new Error("The selected aTalk message has no attachment");
    const descriptor = message.attachment.descriptor;
    if (descriptor.size > inlineLimit) {
      throw new Error(`Attachment is too large for inline MCP content (${descriptor.size} bytes). Use atalk_save_attachment.`);
    }
    const data = Buffer.from(await message.attachment.download()).toString("base64");
    if (descriptor.mimeType.startsWith("image/")) {
      return { content: [{ type: "image" as const, data, mimeType: descriptor.mimeType }] };
    }
    if (descriptor.mimeType.startsWith("audio/")) {
      return { content: [{ type: "audio" as const, data, mimeType: descriptor.mimeType }] };
    }
    return { content: [{
      type: "resource" as const,
      resource: {
        uri: `atalk://attachment/${descriptor.id}/${encodeURIComponent(descriptor.name)}`,
        mimeType: descriptor.mimeType,
        blob: data,
      },
    }] };
  });

  server.registerTool("atalk_save_attachment", {
    description: "Decrypt an attachment into the connector's private attachment directory for local processing.",
    inputSchema: z.object({ messageId: z.string().uuid() }),
  }, async ({ messageId }) => {
    const message = getMessage(inbox, messageId);
    if (!message.attachment) throw new Error("The selected aTalk message has no attachment");
    const descriptor = message.attachment.descriptor;
    const path = join(attachmentDirectory, `${descriptor.id}-${safeName(descriptor.name)}`);
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path, await message.attachment.download(), { mode: 0o600 });
    return textResult({ messageId, path, name: descriptor.name, mimeType: descriptor.mimeType, size: descriptor.size });
  });

  server.registerTool("atalk_send", {
    description: "Start an encrypted aTalk conversation with a human or agent handle.",
    inputSchema: z.object({ handle: z.string().min(2).max(100), text: z.string().min(1).max(32_000) }),
  }, async ({ handle, text }) => textResult(await agent.sendWithDetails(handle, text)));

  server.registerTool("atalk_send_attachment", {
    description: "Start an encrypted aTalk conversation with an image, video, audio or file from an allowed local path (maximum 100 MB).",
    inputSchema: z.object({
      handle: z.string().min(2).max(100),
      filePath: z.string().min(1),
      mimeType: z.string().min(1).max(160).optional(),
      caption: z.string().max(4_000).optional(),
    }),
  }, async ({ handle, filePath, mimeType, caption }) => {
    const file = await readAllowedFile(filePath, allowedFileRoots);
    return textResult(await agent.sendAttachmentWithDetails(handle, {
      data: file.bytes, name: file.name, mimeType: mimeType ?? "application/octet-stream", caption,
    }));
  });

  server.registerTool("atalk_reply", {
    description: "Reply to a received aTalk message, preserving its encrypted conversation.",
    inputSchema: z.object({ messageId: z.string().uuid(), text: z.string().min(1).max(32_000) }),
  }, async ({ messageId, text }) => {
    const message = getMessage(inbox, messageId);
    return textResult({ messageId: await message.reply(text), conversationId: message.conversationId });
  });

  server.registerTool("atalk_reply_attachment", {
    description: "Reply with an image, video, audio or file from an allowed local path (maximum 100 MB).",
    inputSchema: z.object({
      messageId: z.string().uuid(),
      filePath: z.string().min(1),
      mimeType: z.string().min(1).max(160).optional(),
      caption: z.string().max(4_000).optional(),
    }),
  }, async ({ messageId, filePath, mimeType, caption }) => {
    const message = getMessage(inbox, messageId);
    const file = await readAllowedFile(filePath, allowedFileRoots);
    return textResult({
      messageId: await message.replyAttachment({
        data: file.bytes, name: file.name, mimeType: mimeType ?? "application/octet-stream", caption,
      }),
      conversationId: message.conversationId,
    });
  });

  server.registerTool("atalk_send_in_conversation", {
    description: "Send a message inside a known encrypted aTalk conversation.",
    inputSchema: z.object({
      handle: z.string().min(2).max(100), conversationId: z.string().uuid(), text: z.string().min(1).max(32_000),
    }),
  }, async ({ handle, conversationId, text }) => textResult({
    messageId: await agent.sendInConversation(handle, text, conversationId), conversationId,
  }));

  server.registerTool("atalk_mark_read", {
    description: "Mark a previously received aTalk message as read.",
    inputSchema: z.object({ messageId: z.string().uuid() }),
  }, async ({ messageId }) => {
    await getMessage(inbox, messageId).markRead();
    return textResult({ messageId, state: "READ" });
  });

  server.registerTool("atalk_relay_supervision", {
    description: "Relay an owner's text intervention through a supervised aTalk conversation.",
    inputSchema: z.object({ messageId: z.string().uuid(), text: z.string().min(1).max(32_000) }),
  }, async ({ messageId, text }) => {
    const message = getMessage(inbox, messageId);
    if (!message.isSupervisor) throw new Error("The selected message is not a supervisor intervention");
    return textResult({ messageId: await message.relay(text), conversationId: message.conversationId });
  });

  return { server, agent, inbox, start: () => agent.start(), stop: () => agent.stop() };
}
