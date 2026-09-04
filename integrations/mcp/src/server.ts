import { randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  Agent,
  ATALK_SDK_VERSION,
  isManagedRuntimeProcess,
  type DecryptedWorkroomEvent,
  type IncomingMessage,
  type WorkroomDetail,
} from "@atalk/sdk";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { AgentInbox, serializeMessage } from "./inbox.js";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const DEFAULT_INLINE_BYTES = 20 * 1024 * 1024;

const workroomMentionSchema = z.object({
  peerId: z.string().uuid(),
  handle: z.string().regex(/^@[a-z0-9][a-z0-9._-]{1,62}$/u),
  peerType: z.enum(["HUMAN", "AGENT"]),
  intent: z.enum(["direct", "fyi", "approval_requested"]).default("direct"),
}).strict();

const mandatedToolFields = {
  operationId: z.string().uuid().optional().describe("Stable UUID for retries; generated when omitted"),
  mandateId: z.string().uuid().optional(),
  rationale: z.string().min(1).max(4_000).optional(),
};

function useOperationId(operationId: string | undefined): string {
  return operationId ?? randomUUID();
}

const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
});

function taskView(detail: WorkroomDetail) {
  return {
    id: detail.workroom.id,
    status: detail.workroom.status,
    deadline: detail.workroom.deadline ?? null,
    descriptor: detail.descriptor,
    membership: {
      role: detail.membership.role,
      joinedAt: detail.membership.joinedAt,
      leftAt: detail.membership.leftAt ?? null,
    },
    members: detail.members.map(({ membership, peer }) => ({
      id: membership.peerId,
      role: membership.role,
      leftAt: membership.leftAt ?? null,
      handle: peer?.handle ?? null,
      displayName: peer?.displayName ?? null,
      type: peer?.type ?? null,
    })),
    threads: detail.threads.map(({ id, kind, createdAt }) => ({ id, kind, createdAt })),
    permissions: detail.latestMandates.map(({ mandate, revocation }) => ({
      mandateId: mandate.mandateId,
      revision: mandate.revision,
      actorPeerId: mandate.actorPeerId,
      validFrom: mandate.validFrom,
      validUntil: mandate.validUntil,
      revoked: Boolean(revocation),
    })),
    approvals: detail.approvals.map(({ requestId, status, requiredApprovals, eligiblePeerIds, expiresAt }) => ({
      requestId,
      status,
      requiredApprovals,
      eligiblePeerIds,
      expiresAt: expiresAt ?? null,
    })),
  };
}

function workroomEventView(item: DecryptedWorkroomEvent) {
  return {
    sequence: item.sequence,
    event: {
      eventId: item.event.eventId,
      workroomId: item.event.workroomId,
      threadId: item.event.threadId,
      actorPeerId: item.event.actorPeerId,
      kind: item.event.kind,
      createdAt: item.event.createdAt,
    },
    ...(item.projection ? { projection: item.projection } : {}),
    actor: item.actor,
    content: item.content,
    routing: item.routing,
    directedToMe: item.directedToMe,
  };
}

export interface AtalkMcpOptions {
  token?: string;
  baseUrl?: string;
  credentialPath?: string;
  attachmentDirectory?: string;
  allowedFileRoots?: string[];
  /** Explicit operator opt-in for the complete non-autonomous Task history. */
  allowWorkroomAudit?: boolean;
  /** Explicit trusted/manual opt-in for low-level Task attachment I/O. */
  allowUnsafeWorkroomIo?: boolean;
  runtimeUpdateStatusPath?: string | false;
  managedRuntime?: boolean;
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

function environmentFlag(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

async function resolveAllowedFile(filePath: string, roots: string[]): Promise<{ path: string; name: string }> {
  const path = await realpath(resolve(filePath));
  const allowed = await Promise.all(roots.map(async (root) => realpath(root).catch(() => resolve(root))));
  if (!allowed.some((root) => isWithin(root, path))) throw new Error("File path is outside the configured aTalk MCP roots");
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Attachment path must be a regular file");
  if (metadata.size > MAX_ATTACHMENT_BYTES) throw new Error("aTalk attachments cannot exceed 100 MB");
  return { path, name: basename(path) };
}

export function createAtalkMcpServer(options: AtalkMcpOptions = {}): AtalkMcpRuntime {
  const token = options.token ?? process.env.ATALK_AGENT_TOKEN;
  const managedRuntime = isManagedRuntimeProcess() && options.managedRuntime !== false;
  const agent = options.agent ?? new Agent({
    ...(token ? { token } : {}),
    baseUrl: options.baseUrl ?? process.env.ATALK_BASE_URL ?? "https://api.atalk.ar",
    credentialPath: options.credentialPath
      ?? process.env.ATALK_CREDENTIAL_PATH
      ?? join(process.env.PLUGIN_DATA ?? join(homedir(), ".atalk"), "mcp-agent.json"),
    runtime: {
      integration: { name: "@atalk/mcp-server", version: ATALK_SDK_VERSION },
      capabilities: [
        "e2ee", "text", "attachments", "directed-mentions", "supervision", "workrooms", "mcp.tools",
        ...(managedRuntime ? ["runtime.auto-update"] : []),
      ],
      ...(options.runtimeUpdateStatusPath !== undefined
        ? { updateStatusPath: options.runtimeUpdateStatusPath }
        : process.env.ATALK_UPDATE_STATUS_PATH
          ? { updateStatusPath: process.env.ATALK_UPDATE_STATUS_PATH }
          : {}),
    },
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
  const allowWorkroomAudit = options.allowWorkroomAudit
    ?? environmentFlag(process.env.ATALK_ENABLE_WORKROOM_AUDIT);
  const allowUnsafeWorkroomIo = options.allowUnsafeWorkroomIo
    ?? environmentFlag(process.env.ATALK_ENABLE_UNSAFE_WORKROOM_IO);
  const inbox = new AgentInbox();
  const server = new McpServer({ name: "atalk", version: ATALK_SDK_VERSION });
  agent.on("message", (message) => inbox.push(message));
  agent.on("error", (error) => console.error(`[aTalk] ${error.message}`));

  server.registerTool("atalk_status", {
    description: "Show the active aTalk identity, connection state, and queued message count.",
  }, async () => textResult({
    connected: agent.connected,
    peer: agent.peer ?? null,
    pendingMessages: inbox.pending,
    runtime: { metadata: agent.runtimeMetadata, advisory: agent.runtimeUpdate ?? null },
  }));

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

  server.registerTool("atalk_workrooms", {
    description: "List aTalk Tasks available to this agent. Task title/objective are verified and decrypted locally; members, threads and agent-permission metadata are included.",
    inputSchema: z.object({ cursor: z.string().optional(), limit: z.number().int().min(1).max(200).default(50) }),
  }, async ({ cursor, limit }) => {
    const page = await agent.workrooms.list(cursor, limit);
    return textResult({ tasks: page.workrooms.map(taskView), nextCursor: page.nextCursor });
  });

  server.registerTool("atalk_workroom_open", {
    description: "Open one aTalk Task and verify/decrypt its objective locally, including members, threads, current permission metadata and approvals.",
    inputSchema: z.object({ workroomId: z.string().uuid() }),
  }, async ({ workroomId }) => textResult(taskView(await agent.workrooms.get(workroomId, 0, 1))));

  server.registerTool("atalk_workroom_receive", {
    description: "Durably receive only Task/Workroom events explicitly addressed to this agent. General room traffic and messages for other agents never trigger this automation surface.",
    inputSchema: z.object({ workroomId: z.string().uuid(), limit: z.number().int().min(1).max(500).default(100) }),
  }, async ({ workroomId, limit }) => {
    const events: unknown[] = [];
    const cursor = await agent.workrooms.poll(workroomId, (event) => {
      // Keep the MCP boundary fail-closed even when a custom Agent instance is
      // injected. The SDK already applies the same structured routing rule.
      if (event.directedToMe && event.routing?.directedToMe === true) {
        events.push(workroomEventView(event));
      }
    }, { limit });
    return textResult({ workroomId, cursor, events });
  });

  if (allowWorkroomAudit) {
    server.registerTool("atalk_workroom_audit", {
      description: "Operator-only complete Task event view. Reads general and other-agent traffic without advancing the autonomous handler cursor; do not use it to trigger model work.",
      inputSchema: z.object({
        workroomId: z.string().uuid(),
        afterSequence: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(500).default(100),
      }),
    }, async ({ workroomId, afterSequence, limit }) => {
      const page = await agent.workrooms.readAuditEvents(workroomId, afterSequence, limit);
      return textResult({
        workroomId,
        events: page.events.map(workroomEventView),
        nextAfterSequence: page.nextAfterSequence,
      });
    });
  }

  server.registerTool("atalk_workroom_publish", {
    description: "Agent-permission-aware advanced publication of a structured Task message, activity, plan, artifact or deliverable. It stops for approval or denial and records a signed receipt after success.",
    inputSchema: z.object({
      workroomId: z.string().uuid(),
      threadId: z.string().uuid(),
      payload: z.record(z.string(), z.unknown()),
      ...mandatedToolFields,
      eventId: z.string().uuid().optional(),
      idempotencyKey: z.string().min(8).max(160).optional(),
      projection: z.record(z.string(), z.unknown()).optional(),
    }),
  }, async ({ workroomId, threadId, payload, operationId, mandateId, rationale, eventId, idempotencyKey, projection }) => {
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.publishMandated({
      workroomId, threadId, operationId: stableOperationId, payload: payload as never,
      ...(mandateId ? { mandateId } : {}),
      ...(rationale ? { rationale } : {}),
      publish: {
        ...(eventId ? { eventId } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        ...(projection ? { projection: projection as never } : {}),
      },
    });
    return textResult({ operationId: stableOperationId, result });
  });

  server.registerTool("atalk_workroom_message", {
    description: "Send a simple encrypted message to one Task/Workroom thread with structured agent or human mentions.",
    inputSchema: z.object({
      workroomId: z.string().uuid(),
      threadId: z.string().uuid(),
      ...mandatedToolFields,
      body: z.string().min(1).max(200_000),
      mentions: z.array(workroomMentionSchema).max(100).default([]),
      replyToEventId: z.string().uuid().optional(),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, body, mentions, replyToEventId }) => {
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.publishMandated({
      workroomId, threadId, operationId: stableOperationId,
      ...(mandateId ? { mandateId } : {}),
      ...(rationale ? { rationale } : {}),
      payload: { version: 1, kind: "message", threadId, body, mentions, ...(replyToEventId ? { replyToEventId } : {}) },
    });
    return textResult({ operationId: stableOperationId, result });
  });

  server.registerTool("atalk_workroom_activity", {
    description: "Publish a concise encrypted progress/activity update to a Task/Workroom thread.",
    inputSchema: z.object({
      workroomId: z.string().uuid(), threadId: z.string().uuid(),
      ...mandatedToolFields,
      activityType: z.string().min(1).max(160), summary: z.string().min(1).max(4_000),
      mentions: z.array(workroomMentionSchema).max(100).default([]),
      sourceEventIds: z.array(z.string().uuid()).max(100).default([]),
      attributes: z.record(z.string(), z.string().max(4_000)).default({}),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, activityType, summary, mentions, sourceEventIds, attributes }) => {
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.publishMandated({
      workroomId, threadId, operationId: stableOperationId,
      ...(mandateId ? { mandateId } : {}),
      ...(rationale ? { rationale } : {}),
      payload: { version: 1, kind: "activity", threadId, activityType, summary, mentions, sourceEventIds, attributes },
    });
    return textResult({ operationId: stableOperationId, result });
  });

  server.registerTool("atalk_workroom_plan", {
    description: "Publish a permission-aware versioned Task plan. Assigning a step to a peer directs the event to that human or agent.",
    inputSchema: z.object({
      workroomId: z.string().uuid(), threadId: z.string().uuid(), ...mandatedToolFields,
      planId: z.string().uuid().optional(), planVersion: z.number().int().positive(),
      summary: z.string().min(1).max(2_000),
      steps: z.array(z.object({
        id: z.string().min(1).max(160), title: z.string().min(1).max(500),
        status: z.enum(["executing", "waiting_approval", "blocked", "completed", "cancelled", "expired"]),
        assignedPeerIds: z.array(z.string().uuid()).max(100).default([]),
        dependsOnStepIds: z.array(z.string().min(1).max(160)).max(100).default([]),
        deadline: z.string().datetime({ offset: true }).optional(),
      }).strict()).min(1).max(500),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, planId, planVersion, summary, steps }) => {
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.publishMandated({
      workroomId, threadId, operationId: stableOperationId,
      ...(mandateId ? { mandateId } : {}),
      ...(rationale ? { rationale } : {}),
      payload: { version: 1, kind: "plan", planVersion, summary, steps, ...(planId ? { planId } : {}) },
    });
    return textResult({ operationId: stableOperationId, result });
  });

  server.registerTool("atalk_workroom_deliverable", {
    description: "Submit an existing encrypted artifact version as a permission-aware deliverable for human review.",
    inputSchema: z.object({
      workroomId: z.string().uuid(), threadId: z.string().uuid(), ...mandatedToolFields,
      artifactId: z.string().uuid(), artifactVersion: z.number().int().positive(),
      artifactVersionId: z.string().uuid(), deliverableId: z.string().uuid().optional(),
      acceptanceCriteria: z.array(z.string().min(1).max(1_000)).min(1).max(100),
      note: z.string().max(4_000).optional(),
      mentions: z.array(workroomMentionSchema).max(100).default([]),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, artifactId, artifactVersion, artifactVersionId, deliverableId, acceptanceCriteria, note, mentions }) => {
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.publishMandated({
      workroomId, threadId, operationId: stableOperationId,
      ...(mandateId ? { mandateId } : {}),
      ...(rationale ? { rationale } : {}),
      payload: {
        version: 1, kind: "deliverable", artifactId, artifactVersion, artifactVersionId, acceptanceCriteria, mentions,
        ...(deliverableId ? { deliverableId } : {}), ...(note ? { note } : {}),
      },
    });
    return textResult({ operationId: stableOperationId, result });
  });

  if (allowUnsafeWorkroomIo) {
    server.registerTool("atalk_workroom_upload", {
      description: "Low-level encrypted upload for trusted/manual clients. Agent runtimes should use atalk_workroom_submit_file so the agent permission is enforced and the artifact is published.",
      inputSchema: z.object({
        workroomId: z.string().uuid(),
        filePath: z.string().min(1),
        mimeType: z.string().min(1).max(160).optional(),
      }),
    }, async ({ workroomId, filePath, mimeType }) => {
      const file = await resolveAllowedFile(filePath, allowedFileRoots);
      return textResult({ descriptor: await agent.workrooms.uploadAttachmentFile({
        workroomId, path: file.path, name: file.name, mimeType: mimeType ?? "application/octet-stream",
      }) });
    });
  }

  server.registerTool("atalk_workroom_submit_file", {
    description: "Check the agent permission, encrypt, upload and publish one Task file (maximum 100 MB), then record a signed execution receipt.",
    inputSchema: z.object({
      workroomId: z.string().uuid(), threadId: z.string().uuid(), ...mandatedToolFields,
      filePath: z.string().min(1), mimeType: z.string().min(1).max(160).optional(),
      title: z.string().min(1).max(500).optional(), description: z.string().max(4_000).optional(),
      artifactType: z.string().min(1).max(160).optional(), artifactId: z.string().uuid().optional(),
      artifactVersion: z.number().int().positive().optional(),
      mentions: z.array(workroomMentionSchema).max(100).default([]),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, filePath, mimeType, title, description, artifactType, artifactId, artifactVersion, mentions }) => {
    const file = await resolveAllowedFile(filePath, allowedFileRoots);
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.submitFileMandated({
      workroomId, threadId, operationId: stableOperationId, path: file.path, name: file.name, mentions,
      ...(mandateId ? { mandateId } : {}), ...(rationale ? { rationale } : {}),
      ...(mimeType ? { mimeType } : {}), ...(title ? { title } : {}),
      ...(description ? { description } : {}), ...(artifactType ? { artifactType } : {}),
      ...(artifactId ? { artifactId } : {}), ...(artifactVersion ? { artifactVersion } : {}),
    });
    return textResult({ operationId: stableOperationId, result });
  });

  if (allowUnsafeWorkroomIo) {
    server.registerTool("atalk_workroom_save_attachment", {
      description: "Low-level authenticated Task attachment download for trusted/manual clients. Agent runtimes should use atalk_workroom_read_attachment so file.read is permission-checked.",
      inputSchema: z.object({
        descriptor: z.record(z.string(), z.unknown()),
      }),
    }, async ({ descriptor }) => {
      const value = descriptor as never;
      const id = String(descriptor.id ?? "attachment");
      const name = safeName(String(descriptor.name ?? "attachment"));
      const path = join(attachmentDirectory, `${id}-${name}`);
      await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
      await agent.workrooms.downloadAttachmentTo(value, path);
      return textResult({ path, descriptor });
    });
  }

  server.registerTool("atalk_workroom_read_attachment", {
    description: "Check the agent permission, authenticate and decrypt a Task attachment into the connector's private directory.",
    inputSchema: z.object({
      workroomId: z.string().uuid(), threadId: z.string().uuid(), ...mandatedToolFields,
      descriptor: z.record(z.string(), z.unknown()),
    }),
  }, async ({ workroomId, threadId, operationId, mandateId, rationale, descriptor }) => {
    const id = String(descriptor.id ?? "attachment");
    const name = safeName(String(descriptor.name ?? "attachment"));
    const path = join(attachmentDirectory, `${id}-${name}`);
    await mkdir(attachmentDirectory, { recursive: true, mode: 0o700 });
    const stableOperationId = useOperationId(operationId);
    const result = await agent.workrooms.downloadAttachmentToMandated({
      workroomId, threadId, operationId: stableOperationId, descriptor: descriptor as never, path,
      ...(mandateId ? { mandateId } : {}), ...(rationale ? { rationale } : {}),
    });
    return textResult({ operationId: stableOperationId, result });
  });

  server.registerTool("atalk_workroom_mandate_guard", {
    description: "Preview one technical permission decision. Prefer permission-aware Task tools for execution: a preview is not an execution boundary and does not record a receipt.",
    inputSchema: z.object({ request: z.record(z.string(), z.unknown()) }),
  }, async ({ request }) => textResult(await agent.workrooms.guardMandateUse(request as never)));

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
    await message.attachment.downloadTo(path);
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
    const file = await resolveAllowedFile(filePath, allowedFileRoots);
    return textResult(await agent.sendAttachmentFileWithDetails(handle, {
      path: file.path, name: file.name, mimeType: mimeType ?? "application/octet-stream", caption,
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
    const file = await resolveAllowedFile(filePath, allowedFileRoots);
    return textResult({
      messageId: await message.replyAttachmentFile({
        path: file.path, name: file.name, mimeType: mimeType ?? "application/octet-stream", caption,
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
