import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentAttachmentInput, type IncomingMessage } from "@atalk/sdk";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { getAtalkRuntime } from "./runtime.js";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

interface ResolvedAtalkAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  token?: string;
  baseUrl: string;
  credentialPath: string;
}

const activeAgents = new Map<string, Agent>();

export function resolveAtalkAccount(_cfg: OpenClawConfig, accountId?: string | null): ResolvedAtalkAccount {
  const credentialPath = process.env.ATALK_CREDENTIAL_PATH ?? join(homedir(), ".atalk", "openclaw-agent.json");
  const token = process.env.ATALK_AGENT_TOKEN;
  return {
    accountId: accountId || "default",
    enabled: process.env.ATALK_ENABLED !== "false",
    configured: Boolean(token || existsSync(credentialPath)),
    ...(token ? { token } : {}),
    baseUrl: process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath,
  };
}

export function normalizeAtalkTarget(value: string): string {
  const target = value.replace(/^atalk:/u, "").trim();
  return target.startsWith("@") ? target : `@${target}`;
}

export function mediaKind(message: IncomingMessage): "image" | "video" | "audio" | "document" | "unknown" {
  const descriptor = message.attachment?.descriptor;
  if (!descriptor) return "unknown";
  if (descriptor.kind === "IMAGE" || descriptor.mimeType.startsWith("image/")) return "image";
  if (descriptor.kind === "VIDEO" || descriptor.mimeType.startsWith("video/")) return "video";
  if (descriptor.mimeType.startsWith("audio/")) return "audio";
  return "document";
}

async function stageInboundAttachment(message: IncomingMessage) {
  if (!message.attachment) return [];
  const runtime = getAtalkRuntime();
  const descriptor = message.attachment.descriptor;
  const bytes = await message.attachment.download();
  const saved = await runtime.channel.media.saveMediaBuffer(
    Buffer.from(bytes),
    descriptor.mimeType,
    "inbound",
    MAX_ATTACHMENT_BYTES,
    descriptor.name,
    descriptor.name,
  );
  return [{
    path: saved.path,
    url: saved.path,
    contentType: descriptor.mimeType,
    kind: mediaKind(message),
    messageId: message.id,
  }];
}

async function loadOutboundAttachment(
  mediaUrl: string,
  access?: { localRoots?: readonly string[]; readFile?: (filePath: string) => Promise<Buffer>; workspaceDir?: string },
): Promise<AgentAttachmentInput> {
  const runtime = getAtalkRuntime();
  const loaded = await runtime.media.loadWebMedia(mediaUrl, {
    maxBytes: MAX_ATTACHMENT_BYTES,
    localRoots: access?.localRoots ?? [process.cwd(), join(homedir(), ".openclaw")],
    ...(access?.readFile ? { readFile: access.readFile, hostReadCapability: true } : {}),
    ...(access?.workspaceDir ? { workspaceDir: access.workspaceDir } : {}),
  });
  return {
    data: new Uint8Array(loaded.buffer),
    name: loaded.fileName || "attachment",
    mimeType: loaded.contentType || "application/octet-stream",
  };
}

async function deliverReply(message: IncomingMessage, payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) {
  const text = payload.text?.trim();
  const mediaUrls = (payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [])
    .filter((value): value is string => Boolean(value?.trim()));
  if (mediaUrls.length === 0) {
    if (text) await (message.isSupervisor ? message.relay(text) : message.reply(text));
    return;
  }
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const attachment = await loadOutboundAttachment(mediaUrl);
    const input = { ...attachment, ...(index === 0 && text ? { caption: text } : {}) };
    await (message.isSupervisor ? message.relayAttachment(input) : message.replyAttachment(input));
  }
}

async function dispatchIncoming(
  cfg: OpenClawConfig,
  account: ResolvedAtalkAccount,
  agent: Agent,
  message: IncomingMessage,
): Promise<void> {
  const runtime = getAtalkRuntime();
  const channel = runtime.channel;
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: "atalk",
    accountId: account.accountId,
    peer: { kind: "direct", id: message.sender.id },
  });
  const senderHandle = message.sender.handle;
  const body = message.text || (message.attachment ? `[aTalk attachment: ${message.attachment.descriptor.name}]` : "");
  const media = await stageInboundAttachment(message);
  const ctx = channel.inbound.buildContext({
    channel: "atalk",
    provider: "atalk",
    surface: "atalk",
    accountId: route.accountId,
    messageId: message.id,
    messageIdFull: message.id,
    timestamp: message.receivedAt.getTime(),
    from: `atalk:${senderHandle}`,
    sender: {
      id: message.sender.id,
      name: message.sender.displayName,
      username: senderHandle,
    },
    conversation: { kind: "direct", id: message.conversationId, label: message.sender.displayName },
    route: {
      agentId: route.agentId,
      accountId: route.accountId,
      routeSessionKey: route.sessionKey,
      dispatchSessionKey: route.sessionKey,
    },
    reply: { to: `atalk:${senderHandle}`, originatingTo: senderHandle },
    message: { rawBody: body, body: body, bodyForAgent: body, commandBody: body },
    media,
  });
  await message.markRead();
  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: { deliver: async (payload) => deliverReply(message, payload) },
  });
}

const plugin: ChannelPlugin<ResolvedAtalkAccount> = {
  id: "atalk",
  meta: {
    id: "atalk",
    label: "aTalk",
    selectionLabel: "aTalk (encrypted agent network)",
    docsPath: "https://github.com/atalk-network/atalk-developers/tree/main/integrations/openclaw",
    docsLabel: "aTalk",
    blurb: "End-to-end encrypted text and multimedia messaging between people and AI agents.",
    aliases: ["atalk"],
    markdownCapable: false,
  },
  capabilities: { chatTypes: ["direct"], reply: true, media: true, blockStreaming: true },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: resolveAtalkAccount,
    isEnabled: (account) => account.enabled,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      connected: activeAgents.get(account.accountId)?.connected ?? false,
      credentialSource: account.token ? "activation-token" : "credential-file",
      baseUrl: account.baseUrl,
    }),
  },
  setup: { applyAccountConfig: ({ cfg }) => cfg },
  gateway: {
    startAccount: async (ctx) => {
      if (!ctx.account.configured) {
        throw new Error("Set ATALK_AGENT_TOKEN for first activation or ATALK_CREDENTIAL_PATH for persisted credentials");
      }
      const agent = new Agent({
        ...(ctx.account.token ? { token: ctx.account.token } : {}),
        baseUrl: ctx.account.baseUrl,
        credentialPath: ctx.account.credentialPath,
      });
      activeAgents.set(ctx.accountId, agent);
      agent.on("error", (error) => ctx.log?.error(error.message));
      agent.on("message", (message) => dispatchIncoming(ctx.cfg, ctx.account, agent, message));
      try {
        await agent.start();
        ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: true, connected: true, lastConnectedAt: Date.now() });
        ctx.log?.info(`connected as ${agent.peer?.handle ?? "unknown"}`);
        await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
      } finally {
        activeAgents.delete(ctx.accountId);
        await agent.stop();
        ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: false, connected: false });
      }
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 32_000,
    resolveTarget: ({ to }) => to
      ? { ok: true, to: normalizeAtalkTarget(to) }
      : { ok: false, error: new Error("An aTalk recipient handle is required") },
    sendText: async ({ accountId, to, text }) => {
      const agent = activeAgents.get(accountId ?? "default");
      if (!agent) throw new Error(`aTalk account ${accountId ?? "default"} is not connected`);
      const sent = await agent.sendWithDetails(normalizeAtalkTarget(to), text);
      return { channel: "atalk", messageId: sent.messageId, conversationId: sent.conversationId };
    },
    sendMedia: async ({ accountId, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile }) => {
      if (!mediaUrl) throw new Error("An outbound aTalk attachment is required");
      const agent = activeAgents.get(accountId ?? "default");
      if (!agent) throw new Error(`aTalk account ${accountId ?? "default"} is not connected`);
      const attachment = await loadOutboundAttachment(mediaUrl, {
        localRoots: mediaAccess?.localRoots ?? mediaLocalRoots,
        readFile: mediaAccess?.readFile ?? mediaReadFile,
        workspaceDir: mediaAccess?.workspaceDir,
      });
      const sent = await agent.sendAttachmentWithDetails(normalizeAtalkTarget(to), {
        ...attachment,
        ...(text.trim() ? { caption: text.trim() } : {}),
      });
      return { channel: "atalk", messageId: sent.messageId, conversationId: sent.conversationId };
    },
  },
};

export const atalkPlugin = plugin;
