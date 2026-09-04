import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  type AgentAttachmentFileInput,
  type DecryptedWorkroomEvent,
  type IncomingMessage,
  type WorkroomDetail,
} from "@atalk/sdk";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { saveMediaStream } from "openclaw/plugin-sdk/media-store";
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

/** Used only by tools registered by this same native plugin process. */
export function getActiveAtalkAgent(accountId = "default"): Agent | undefined {
  return activeAgents.get(accountId);
}

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
  const descriptor = message.attachment.descriptor;
  const directory = await mkdtemp(join(tmpdir(), "atalk-openclaw-inbound-"));
  const path = join(directory, safeFileName(descriptor.name));
  try {
    await message.attachment.downloadTo(path);
    const saved = await saveMediaStream(
      createReadStream(path),
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
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function stageWorkroomAttachments(
  agent: Agent,
  detail: WorkroomDetail,
  item: DecryptedWorkroomEvent,
) {
  if (item.content.kind !== "artifact_version" || !item.content.attachments?.length) return [];
  const media = [];
  for (const descriptor of item.content.attachments) {
    const directory = await mkdtemp(join(tmpdir(), "atalk-openclaw-task-"));
    const path = join(directory, safeFileName(descriptor.name));
    try {
      const result = await agent.workrooms.downloadAttachmentToMandated({
        workroomId: detail.workroom.id,
        threadId: item.event.threadId,
        operationId: stableUuid(`${item.event.eventId}:read:${descriptor.id}`),
        descriptor,
        path,
        summary: `Read Task file: ${descriptor.name}`,
        effect: "Decrypt this Task file inside OpenClaw so the assigned agent can process it",
      });
      if (result.status === "requires_approval") throw permissionError(result);
      if (result.status !== "executed") continue;
      const saved = await saveMediaStream(
        createReadStream(result.value),
        descriptor.mimeType,
        "inbound",
        MAX_ATTACHMENT_BYTES,
        descriptor.name,
        descriptor.name,
      );
      media.push({
        path: saved.path,
        url: saved.path,
        contentType: descriptor.mimeType,
        kind: mediaKindFromType(descriptor.mimeType),
        messageId: item.event.eventId,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return media;
}

async function loadOutboundAttachment(
  mediaUrl: string,
  access?: { localRoots?: readonly string[]; readFile?: (filePath: string) => Promise<Buffer>; workspaceDir?: string },
): Promise<{ input: AgentAttachmentFileInput; digest: string; cleanup(): Promise<void> }> {
  const runtime = getAtalkRuntime();
  const loaded = await runtime.media.loadWebMedia(mediaUrl, {
    maxBytes: MAX_ATTACHMENT_BYTES,
    localRoots: access?.localRoots ?? [process.cwd(), join(homedir(), ".openclaw")],
    ...(access?.readFile ? { readFile: access.readFile, hostReadCapability: true } : {}),
    ...(access?.workspaceDir ? { workspaceDir: access.workspaceDir } : {}),
  });
  const directory = await mkdtemp(join(tmpdir(), "atalk-openclaw-outbound-"));
  const name = safeFileName(loaded.fileName || "attachment");
  const path = join(directory, name);
  try {
    await writeFile(path, loaded.buffer, { mode: 0o600 });
    return {
      input: { path, name, mimeType: loaded.contentType || "application/octet-stream" },
      digest: createHash("sha256").update(loaded.buffer).digest("hex"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function deliverReply(message: IncomingMessage, payload: { text?: string; mediaUrl?: string; mediaUrls?: string[] }) {
  const text = payload.text?.trim();
  const mediaUrls = (payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [])
    .filter((value): value is string => Boolean(value?.trim()));
  const relayToCounterparty = shouldRelaySupervisorMessage(message);
  if (mediaUrls.length === 0) {
    if (text) await (relayToCounterparty ? message.relay(text) : message.reply(text));
    return;
  }
  for (const [index, mediaUrl] of mediaUrls.entries()) {
    const attachment = await loadOutboundAttachment(mediaUrl);
    try {
      const input = { ...attachment.input, ...(index === 0 && text ? { caption: text } : {}) };
      await (relayToCounterparty ? message.relayAttachmentFile(input) : message.replyAttachmentFile(input));
    } finally {
      await attachment.cleanup();
    }
  }
}

function safeFileName(value: string): string {
  return value.replace(/[\r\n"\\/]+/gu, "_").slice(0, 180) || "attachment";
}

function stableUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function mediaKindFromType(mimeType: string): "image" | "video" | "audio" | "document" {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}

function responseMention(item: DecryptedWorkroomEvent) {
  return [{
    peerId: item.actor.id,
    handle: item.actor.handle,
    peerType: item.actor.type === "AGENT" ? "AGENT" as const : "HUMAN" as const,
    intent: "direct" as const,
  }];
}

export function renderWorkroomEvent(item: Pick<DecryptedWorkroomEvent, "content" | "routing">): string {
  const content = item.content;
  switch (content.kind) {
    case "message": return content.body;
    case "activity": return `${content.summary}\n\nActivity: ${content.activityType}`;
    case "plan": return [
      content.summary,
      "Your executable assigned steps (execute only these steps):",
      ...item.routing.assignedSteps.map((step) => `- [${step.status}] ${step.title}`),
    ].join("\n");
    case "artifact_version": return [content.title, content.description, content.fileName].filter(Boolean).join("\n");
    case "deliverable": return ["Deliverable submitted for review", content.note].filter(Boolean).join("\n");
    case "cost": return `Task usage recorded: ${content.metric}`;
    case "approval_request": return [
      content.summary ?? content.rationale,
      `Requested effect: ${content.effect ?? content.action}`,
    ].join("\n");
  }
}

/** Agent turns are started only by authenticated structured routing. */
export function shouldDispatchWorkroomEvent(
  item: Pick<DecryptedWorkroomEvent, "directedToMe" | "routing">,
): boolean {
  return item.directedToMe === true
    && item.routing.directedToMe === true;
}

export function mandateFailureMode(result: { status: string }): "retry" | "stop" | undefined {
  if (result.status === "executed") return undefined;
  return result.status === "requires_approval" ? "retry" : "stop";
}

function permissionError(result: { status: string; decision?: unknown }): Error {
  const code = result.decision && typeof result.decision === "object" && "code" in result.decision
    && typeof result.decision.code === "string"
    ? result.decision.code
    : undefined;
  return new Error(`aTalk agent permission ${result.status}${code ? `: ${code}` : ""}`);
}

export function shouldRelaySupervisorMessage(message: Pick<IncomingMessage, "isSupervisor" | "isMentioned">): boolean {
  return message.isSupervisor && !message.isMentioned;
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
  const mentions = message.mentions ?? [];
  const mentionContext = mentions.length > 0
    ? `[aTalk explicit agent mention: ${mentions.map((mention) => mention.handle).join(", ")} | targetedToThisRuntime=${String(message.isMentioned ?? false)}]\n\n`
    : "";
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
    message: { rawBody: body, body: body, bodyForAgent: `${mentionContext}${body}`, commandBody: body },
    media,
  });
  await message.markRead();
  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: { deliver: async (payload) => deliverReply(message, payload) },
  });
}

async function dispatchWorkroomEvent(
  cfg: OpenClawConfig,
  account: ResolvedAtalkAccount,
  agent: Agent,
  detail: WorkroomDetail,
  item: DecryptedWorkroomEvent,
): Promise<void> {
  if (!shouldDispatchWorkroomEvent(item)) return;
  const content = item.content;
  const body = renderWorkroomEvent(item);
  const runtime = getAtalkRuntime();
  const channel = runtime.channel;
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: "atalk",
    accountId: account.accountId,
    peer: { kind: "group", id: detail.workroom.id },
  });
  const media = await stageWorkroomAttachments(agent, detail, item);
  const taskName = detail.descriptor.title ?? detail.descriptor.objective;
  const ctx = channel.inbound.buildContext({
    channel: "atalk",
    provider: "atalk",
    surface: "atalk",
    accountId: route.accountId,
    messageId: item.event.eventId,
    messageIdFull: item.event.eventId,
    timestamp: Date.parse(item.event.createdAt),
    from: `atalk:${item.actor.handle}`,
    sender: { id: item.actor.id, name: item.actor.displayName, username: item.actor.handle },
    conversation: { kind: "group", id: detail.workroom.id, label: taskName },
    route: { agentId: route.agentId, accountId: route.accountId, routeSessionKey: route.sessionKey, dispatchSessionKey: route.sessionKey },
    reply: { to: `atalk-workroom:${detail.workroom.id}`, originatingTo: item.actor.handle },
    message: {
      rawBody: body,
      body,
      bodyForAgent: `[aTalk encrypted Task: ${taskName}; task id: ${detail.workroom.id}; thread id: ${item.event.threadId}; objective: ${detail.descriptor.objective}; reply in this thread; use atalk_task_* tools for plans, deliverables or explicit routing]\n\n${body}`,
      commandBody: body,
    },
    media,
  });
  let deliveryIndex = 0;
  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = payload.text?.trim();
        const mediaUrls = (payload.mediaUrls?.length ? payload.mediaUrls : payload.mediaUrl ? [payload.mediaUrl] : [])
          .filter((value): value is string => Boolean(value?.trim()));
        const index = deliveryIndex;
        deliveryIndex += 1;
        if (mediaUrls.length === 0) {
          if (!text) return;
          const result = await agent.workrooms.publishMandated({
            workroomId: detail.workroom.id,
            threadId: item.event.threadId,
            operationId: stableUuid(`${item.event.eventId}:reply:${index}:${text}`),
            payload: {
              version: 1,
              kind: "message",
              threadId: item.event.threadId,
              body: text,
              mentions: responseMention(item),
              replyToEventId: item.event.eventId,
            },
            summary: "Reply to a directed message in this Task",
            effect: "Share the reply with the Task participants",
          });
          if (mandateFailureMode(result) === "retry") throw permissionError(result);
          return;
        }
        for (const [mediaIndex, mediaUrl] of mediaUrls.entries()) {
          const attachment = await loadOutboundAttachment(mediaUrl);
          try {
            const result = await agent.workrooms.submitFileMandated({
              workroomId: detail.workroom.id,
              threadId: item.event.threadId,
              operationId: stableUuid(
                `${item.event.eventId}:reply:${index}:media:${mediaIndex}:${attachment.digest}:${text ?? ""}`,
              ),
              ...attachment.input,
              ...(text && mediaIndex === 0 ? { description: text } : {}),
              mentions: responseMention(item),
              summary: `Return ${attachment.input.name ?? "a file"} to this Task`,
              effect: "Encrypt and share the generated file with the Task participants",
            });
            if (mandateFailureMode(result) === "retry") throw permissionError(result);
          } finally {
            await attachment.cleanup();
          }
        }
      },
    },
  });
}

async function pollWorkrooms(
  cfg: OpenClawConfig,
  account: ResolvedAtalkAccount,
  agent: Agent,
  signal: AbortSignal,
  log?: { error(message: string): void },
): Promise<void> {
  while (!signal.aborted) {
    try {
      let cursor: string | undefined;
      do {
        const page = await agent.workrooms.list(cursor, 100);
        for (const summary of page.workrooms) {
          if (signal.aborted) return;
          await agent.workrooms.poll(summary.workroom.id, async (event) => {
            const detail = await agent.workrooms.get(summary.workroom.id, 0, 1);
            await dispatchWorkroomEvent(cfg, account, agent, detail, event);
          }, { signal });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && !signal.aborted);
    } catch (error) {
      if (!signal.aborted) log?.error(error instanceof Error ? error.message : String(error));
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
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
  capabilities: { chatTypes: ["direct", "group"], reply: true, media: true, blockStreaming: true },
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
        const workroomPolling = pollWorkrooms(ctx.cfg, ctx.account, agent, ctx.abortSignal, ctx.log);
        ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: true, connected: true, lastConnectedAt: Date.now() });
        ctx.log?.info(`connected as ${agent.peer?.handle ?? "unknown"}`);
        await new Promise<void>((resolve) => ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true }));
        await workroomPolling;
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
      try {
        const sent = await agent.sendAttachmentFileWithDetails(normalizeAtalkTarget(to), {
          ...attachment.input,
          ...(text.trim() ? { caption: text.trim() } : {}),
        });
        return { channel: "atalk", messageId: sent.messageId, conversationId: sent.conversationId };
      } finally {
        await attachment.cleanup();
      }
    },
  },
};

export const atalkPlugin = plugin;
