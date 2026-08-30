import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, type IncomingMessage } from "@atalk/sdk";
import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { getAtalkRuntime } from "./runtime.js";

interface ResolvedAtalkAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  token?: string;
  baseUrl: string;
  credentialPath: string;
}

interface ReplyPayload {
  text?: string;
}

const activeAgents = new Map<string, Agent>();

export function resolveAtalkAccount(_cfg: OpenClawConfig, accountId?: string | null): ResolvedAtalkAccount {
  const credentialPath = process.env.ATALK_CREDENTIAL_PATH ?? join(homedir(), ".atalk", "openclaw-agent.json");
  const token = process.env.ATALK_AGENT_TOKEN;
  return {
    accountId: accountId || "default",
    enabled: process.env.ATALK_ENABLED !== "false",
    configured: Boolean(token || existsSync(credentialPath)),
    token,
    baseUrl: process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath,
  };
}

export function normalizeAtalkTarget(value: string): string {
  const target = value.replace(/^atalk:/u, "").trim();
  return target.startsWith("@") ? target : `@${target}`;
}

async function dispatchIncoming(
  cfg: OpenClawConfig,
  account: ResolvedAtalkAccount,
  agent: Agent,
  message: IncomingMessage,
): Promise<void> {
  const runtime = getAtalkRuntime();
  const channel = runtime.channel as unknown as {
    routing: {
      resolveAgentRoute(input: Record<string, unknown>): {
        agentId: string;
        accountId: string;
        sessionKey: string;
      };
    };
    reply: {
      finalizeInboundContext(input: Record<string, unknown>): unknown;
      dispatchReplyWithBufferedBlockDispatcher(input: {
        ctx: unknown;
        cfg: OpenClawConfig;
        dispatcherOptions: { deliver(payload: ReplyPayload): Promise<void> };
      }): Promise<void>;
    };
  };
  const route = channel.routing.resolveAgentRoute({
    cfg,
    channel: "atalk",
    accountId: account.accountId,
    peer: { kind: "direct", id: message.sender.id },
  });
  const senderHandle = message.sender.handle;
  const ctx = channel.reply.finalizeInboundContext({
    Body: message.text,
    BodyForAgent: message.text,
    RawBody: message.text,
    CommandBody: message.text,
    From: `atalk:${senderHandle}`,
    To: `atalk:${agent.peer?.handle ?? account.accountId}`,
    SenderId: message.sender.id,
    SenderName: message.sender.displayName,
    SenderUsername: senderHandle,
    Provider: "atalk",
    Surface: "atalk",
    ChatType: "direct",
    AccountId: route.accountId,
    AgentId: route.agentId,
    SessionKey: route.sessionKey,
    MessageSid: message.id,
    MessageSidFull: message.id,
    Timestamp: message.receivedAt.getTime(),
    OriginatingChannel: "atalk",
    OriginatingTo: senderHandle,
  });

  await message.markRead();
  await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const text = payload.text?.trim();
        if (text) await (message.isSupervisor ? message.relay(text) : message.reply(text));
      },
    },
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
    blurb: "End-to-end encrypted messaging between people and AI agents.",
    aliases: ["atalk"],
    markdownCapable: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    reply: true,
    media: false,
    blockStreaming: true,
  },
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
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
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
        ctx.setStatus({
          ...ctx.getStatus(),
          accountId: ctx.accountId,
          running: true,
          connected: true,
          lastConnectedAt: Date.now(),
        });
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
      const id = accountId ?? "default";
      const agent = activeAgents.get(id);
      if (!agent) throw new Error(`aTalk account ${id} is not connected`);
      const sent = await agent.sendWithDetails(normalizeAtalkTarget(to), text);
      return {
        channel: "atalk",
        messageId: sent.messageId,
        conversationId: sent.conversationId,
      };
    },
  },
};

export const atalkPlugin = plugin;
