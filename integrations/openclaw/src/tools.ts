import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Agent, WorkroomDetail } from "@atalk/sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { Type } from "typebox";
import { getActiveAtalkAgent } from "./channel.js";

const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const uuid = () => Type.String({ format: "uuid" });
const handle = () => Type.String({ pattern: "^@[a-z0-9][a-z0-9._-]{1,62}$" });
const handles = () => Type.Array(handle(), { maxItems: 100, default: [] });
const common = {
  workroomId: uuid(),
  threadId: uuid(),
  operationId: Type.Optional(uuid()),
  mandateId: Type.Optional(uuid()),
  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
};

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

function operationId(value?: string): string {
  return value ?? randomUUID();
}

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
    threads: detail.threads.map((thread) => ({ id: thread.id, kind: thread.kind, createdAt: thread.createdAt })),
    permissions: detail.latestMandates.map(({ mandate, revocation }) => ({
      mandateId: mandate.mandateId,
      revision: mandate.revision,
      actorPeerId: mandate.actorPeerId,
      validFrom: mandate.validFrom,
      validUntil: mandate.validUntil,
      revoked: Boolean(revocation),
    })),
    approvals: detail.approvals.map((approval) => ({
      requestId: approval.requestId,
      status: approval.status,
      requiredApprovals: approval.requiredApprovals,
      eligiblePeerIds: approval.eligiblePeerIds,
      expiresAt: approval.expiresAt ?? null,
    })),
  };
}

function participantIds(detail: WorkroomDetail): string[] {
  return detail.members
    .filter(({ membership }) => !membership.leftAt)
    .map(({ membership }) => membership.peerId);
}

function resolveMembers(detail: WorkroomDetail, requestedHandles: string[]) {
  const activeMembers = detail.members.filter(({ membership }) => !membership.leftAt && membership.peerId);
  return requestedHandles.map((requested) => {
    const member = activeMembers.find(({ peer }) => peer?.handle === requested);
    if (!member?.peer) throw new Error(`Active Task participant not found: ${requested}`);
    return member.peer;
  });
}

function mentions(detail: WorkroomDetail, requestedHandles: string[]) {
  return resolveMembers(detail, requestedHandles).map((peer) => ({
    peerId: peer.id,
    handle: peer.handle,
    peerType: peer.type === "AGENT" ? "AGENT" as const : "HUMAN" as const,
    intent: "direct" as const,
  }));
}

async function workspaceFile(filePath: string, workspaceDir: string) {
  const root = await realpath(resolve(workspaceDir));
  const path = await realpath(resolve(workspaceDir, filePath));
  const fromRoot = relative(root, path);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error("Task files must stay inside the active OpenClaw workspace");
  }
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Task attachment path is not a regular file");
  if (metadata.size > MAX_ATTACHMENT_BYTES) throw new Error("aTalk Task attachments cannot exceed 100 MB");
  return path;
}

export function buildAtalkTaskTools(agent: Agent, context: { workspaceDir?: string }) {
  const tools = [
      {
        name: "atalk_task_list",
        label: "List aTalk Tasks",
        description: "List encrypted aTalk Tasks assigned to this agent. Titles and objectives are verified and decrypted locally.",
        parameters: Type.Object({
          cursor: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: { cursor?: string; limit?: number }) {
          const page = await agent.workrooms.list(params.cursor, params.limit ?? 50);
          return jsonResult({ tasks: page.workrooms.map(taskView), nextCursor: page.nextCursor });
        },
      },
      {
        name: "atalk_task_open",
        label: "Open an aTalk Task",
        description: "Open one encrypted aTalk Task and inspect its verified objective, participants, threads, permission metadata and approval status.",
        parameters: Type.Object({ workroomId: uuid() }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: { workroomId: string }) {
          return jsonResult(taskView(await agent.workrooms.get(params.workroomId, 0, 1)));
        },
      },
      {
        name: "atalk_task_message",
        label: "Message an aTalk Task",
        description: "Publish an encrypted Task message under the agent's current permission. Mention handles to direct it to specific humans or agents.",
        parameters: Type.Object({
          ...common,
          body: Type.String({ minLength: 1, maxLength: 200_000 }),
          mentionHandles: Type.Optional(handles()),
          replyToEventId: Type.Optional(uuid()),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: {
          workroomId: string; threadId: string; operationId?: string; mandateId?: string; rationale?: string;
          body: string; mentionHandles?: string[]; replyToEventId?: string;
        }) {
          const id = operationId(params.operationId);
          const detail = await agent.workrooms.get(params.workroomId, 0, 1);
          const result = await agent.workrooms.publishMandated({
            workroomId: params.workroomId,
            threadId: params.threadId,
            operationId: id,
            ...(params.mandateId ? { mandateId: params.mandateId } : {}),
            ...(params.rationale ? { rationale: params.rationale } : {}),
            participantPeerIds: participantIds(detail),
            payload: {
              version: 1,
              kind: "message",
              threadId: params.threadId,
              body: params.body,
              mentions: mentions(detail, params.mentionHandles ?? []),
              ...(params.replyToEventId ? { replyToEventId: params.replyToEventId } : {}),
            },
          });
          return jsonResult({ operationId: id, result });
        },
      },
      {
        name: "atalk_task_activity",
        label: "Update aTalk Task activity",
        description: "Publish a concise encrypted progress update under the agent's current permission.",
        parameters: Type.Object({
          ...common,
          activityType: Type.String({ minLength: 1, maxLength: 160 }),
          summary: Type.String({ minLength: 1, maxLength: 4_000 }),
          mentionHandles: Type.Optional(handles()),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: {
          workroomId: string; threadId: string; operationId?: string; mandateId?: string; rationale?: string;
          activityType: string; summary: string; mentionHandles?: string[];
        }) {
          const id = operationId(params.operationId);
          const detail = await agent.workrooms.get(params.workroomId, 0, 1);
          const result = await agent.workrooms.publishMandated({
            workroomId: params.workroomId,
            threadId: params.threadId,
            operationId: id,
            ...(params.mandateId ? { mandateId: params.mandateId } : {}),
            ...(params.rationale ? { rationale: params.rationale } : {}),
            participantPeerIds: participantIds(detail),
            payload: {
              version: 1,
              kind: "activity",
              threadId: params.threadId,
              activityType: params.activityType,
              summary: params.summary,
              mentions: mentions(detail, params.mentionHandles ?? []),
              sourceEventIds: [],
              attributes: {},
            },
          });
          return jsonResult({ operationId: id, result });
        },
      },
      {
        name: "atalk_task_plan",
        label: "Plan an aTalk Task",
        description: "Publish a versioned encrypted Task plan. Assign steps by active participant handle. Requires the explicit plan.update permission.",
        parameters: Type.Object({
          ...common,
          planId: Type.Optional(uuid()),
          planVersion: Type.Integer({ minimum: 1 }),
          summary: Type.String({ minLength: 1, maxLength: 2_000 }),
          steps: Type.Array(Type.Object({
            id: Type.String({ minLength: 1, maxLength: 160 }),
            title: Type.String({ minLength: 1, maxLength: 500 }),
            status: Type.Union([
              Type.Literal("executing"), Type.Literal("waiting_approval"), Type.Literal("blocked"),
              Type.Literal("completed"), Type.Literal("cancelled"), Type.Literal("expired"),
            ]),
            assignedHandles: Type.Optional(handles()),
            dependsOnStepIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { maxItems: 100 })),
            deadline: Type.Optional(Type.String({ format: "date-time" })),
          }, { additionalProperties: false }), { minItems: 1, maxItems: 500 }),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: {
          workroomId: string; threadId: string; operationId?: string; mandateId?: string; rationale?: string;
          planId?: string; planVersion: number; summary: string;
          steps: Array<{ id: string; title: string; status: "executing" | "waiting_approval" | "blocked" | "completed" | "cancelled" | "expired"; assignedHandles?: string[]; dependsOnStepIds?: string[]; deadline?: string }>;
        }) {
          const id = operationId(params.operationId);
          const detail = await agent.workrooms.get(params.workroomId, 0, 1);
          const result = await agent.workrooms.publishMandated({
            workroomId: params.workroomId,
            threadId: params.threadId,
            operationId: id,
            ...(params.mandateId ? { mandateId: params.mandateId } : {}),
            ...(params.rationale ? { rationale: params.rationale } : {}),
            participantPeerIds: participantIds(detail),
            payload: {
              version: 1,
              kind: "plan",
              ...(params.planId ? { planId: params.planId } : {}),
              planVersion: params.planVersion,
              summary: params.summary,
              steps: params.steps.map((step) => ({
                id: step.id,
                title: step.title,
                status: step.status,
                assignedPeerIds: resolveMembers(detail, step.assignedHandles ?? []).map(({ id: peerId }) => peerId),
                dependsOnStepIds: step.dependsOnStepIds ?? [],
                ...(step.deadline ? { deadline: step.deadline } : {}),
              })),
            },
          });
          return jsonResult({ operationId: id, result });
        },
      },
      {
        name: "atalk_task_deliverable",
        label: "Submit an aTalk Task deliverable",
        description: "Submit an encrypted artifact version for review under the agent's current deliverable.submit permission.",
        parameters: Type.Object({
          ...common,
          artifactId: uuid(),
          artifactVersion: Type.Integer({ minimum: 1 }),
          artifactVersionId: uuid(),
          deliverableId: Type.Optional(uuid()),
          acceptanceCriteria: Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { minItems: 1, maxItems: 100 }),
          note: Type.Optional(Type.String({ maxLength: 4_000 })),
          mentionHandles: Type.Optional(handles()),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: {
          workroomId: string; threadId: string; operationId?: string; mandateId?: string; rationale?: string;
          artifactId: string; artifactVersion: number; artifactVersionId: string; deliverableId?: string;
          acceptanceCriteria: string[]; note?: string; mentionHandles?: string[];
        }) {
          const id = operationId(params.operationId);
          const detail = await agent.workrooms.get(params.workroomId, 0, 1);
          const result = await agent.workrooms.publishMandated({
            workroomId: params.workroomId,
            threadId: params.threadId,
            operationId: id,
            ...(params.mandateId ? { mandateId: params.mandateId } : {}),
            ...(params.rationale ? { rationale: params.rationale } : {}),
            participantPeerIds: participantIds(detail),
            payload: {
              version: 1,
              kind: "deliverable",
              artifactId: params.artifactId,
              artifactVersion: params.artifactVersion,
              artifactVersionId: params.artifactVersionId,
              ...(params.deliverableId ? { deliverableId: params.deliverableId } : {}),
              acceptanceCriteria: params.acceptanceCriteria,
              ...(params.note ? { note: params.note } : {}),
              mentions: mentions(detail, params.mentionHandles ?? []),
            },
          });
          return jsonResult({ operationId: id, result });
        },
      },
    ];

    if (context.workspaceDir) {
      tools.push({
        name: "atalk_task_submit_file",
        label: "Attach a file to an aTalk Task",
        description: "Encrypt and attach one file from the active OpenClaw workspace to a Task. Returns artifact identifiers that can be submitted as a deliverable.",
        parameters: Type.Object({
          ...common,
          filePath: Type.String({ minLength: 1 }),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
          description: Type.Optional(Type.String({ maxLength: 4_000 })),
          artifactType: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
          artifactId: Type.Optional(uuid()),
          artifactVersion: Type.Optional(Type.Integer({ minimum: 1 })),
          mentionHandles: Type.Optional(handles()),
        }, { additionalProperties: false }),
        async execute(_toolCallId: string, params: {
          workroomId: string; threadId: string; operationId?: string; mandateId?: string; rationale?: string;
          filePath: string; name?: string; mimeType?: string; title?: string; description?: string;
          artifactType?: string; artifactId?: string; artifactVersion?: number; mentionHandles?: string[];
        }) {
          const id = operationId(params.operationId);
          const detail = await agent.workrooms.get(params.workroomId, 0, 1);
          const path = await workspaceFile(params.filePath, context.workspaceDir!);
          const result = await agent.workrooms.submitFileMandated({
            workroomId: params.workroomId,
            threadId: params.threadId,
            operationId: id,
            path,
            ...(params.mandateId ? { mandateId: params.mandateId } : {}),
            ...(params.rationale ? { rationale: params.rationale } : {}),
            ...(params.name ? { name: params.name } : {}),
            ...(params.mimeType ? { mimeType: params.mimeType } : {}),
            ...(params.title ? { title: params.title } : {}),
            ...(params.description ? { description: params.description } : {}),
            ...(params.artifactType ? { artifactType: params.artifactType } : {}),
            ...(params.artifactId ? { artifactId: params.artifactId } : {}),
            ...(params.artifactVersion ? { artifactVersion: params.artifactVersion } : {}),
            mentions: mentions(detail, params.mentionHandles ?? []),
            participantPeerIds: participantIds(detail),
          });
          return jsonResult({ operationId: id, result });
        },
      });
    }
  return tools;
}

export function registerAtalkTaskTools(api: OpenClawPluginApi): void {
  api.registerTool((context) => {
    const agent = getActiveAtalkAgent(context.agentAccountId ?? "default");
    return agent ? buildAtalkTaskTools(agent, context) : null;
  }, {
    names: [
      "atalk_task_list", "atalk_task_open", "atalk_task_message", "atalk_task_activity",
      "atalk_task_plan", "atalk_task_deliverable", "atalk_task_submit_file",
    ],
  });
}
