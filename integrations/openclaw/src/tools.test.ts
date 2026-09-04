import type { Agent, WorkroomDetail } from "@atalk/sdk";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildAtalkTaskTools } from "./tools.js";

const WORKROOM_ID = "11111111-1111-4111-8111-111111111111";
const THREAD_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const HUMAN_ID = "44444444-4444-4444-8444-444444444444";
const ARTIFACT_ID = "77777777-7777-4777-8777-777777777777";
const ARTIFACT_VERSION_ID = "88888888-8888-4888-8888-888888888888";

function detail(): WorkroomDetail {
  return {
    workroom: {
      id: WORKROOM_ID,
      createdByPeerId: HUMAN_ID,
      status: "executing",
      descriptorEnvelope: {} as never,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
      currentKeyEpoch: 1,
      descriptorHash: "hash",
      idempotencyKey: "task",
    },
    descriptor: { version: 1, objective: "Prepare the launch brief", dataCategories: [] },
    membership: {
      id: "55555555-5555-4555-8555-555555555555",
      workroomId: WORKROOM_ID,
      peerId: AGENT_ID,
      peerType: "AGENT",
      role: "worker",
      joinedAt: "2026-09-03T00:00:00.000Z",
      addedByPeerId: HUMAN_ID,
      idempotencyKey: "member-agent",
    },
    members: [
      {
        membership: {
          id: "55555555-5555-4555-8555-555555555555",
          workroomId: WORKROOM_ID,
          peerId: AGENT_ID,
          peerType: "AGENT",
          role: "worker",
          joinedAt: "2026-09-03T00:00:00.000Z",
          addedByPeerId: HUMAN_ID,
          idempotencyKey: "member-agent",
        },
        peer: {
          id: AGENT_ID, type: "AGENT", handle: "@analysis.agent", displayName: "Analysis agent",
          signingPublicKey: "sign", encryptionPublicKey: "encrypt",
        },
      },
      {
        membership: {
          id: "66666666-6666-4666-8666-666666666666",
          workroomId: WORKROOM_ID,
          peerId: HUMAN_ID,
          peerType: "HUMAN",
          role: "owner",
          joinedAt: "2026-09-03T00:00:00.000Z",
          addedByPeerId: HUMAN_ID,
          idempotencyKey: "member-owner",
        },
        peer: {
          id: HUMAN_ID, type: "HUMAN", handle: "@product.owner", displayName: "Product owner",
          signingPublicKey: "sign", encryptionPublicKey: "encrypt",
        },
      },
    ],
    threads: [{
      id: THREAD_ID,
      workroomId: WORKROOM_ID,
      kind: "main",
      createdByPeerId: HUMAN_ID,
      createdAt: "2026-09-03T00:00:00.000Z",
      idempotencyKey: "thread",
    }],
    latestMandates: [], approvals: [], latestReceiptHash: null,
  };
}

describe("aTalk OpenClaw Task tools", () => {
  it("declares every native Task tool in the OpenClaw manifest contract", async () => {
    const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8")) as {
      contracts: { tools: string[] };
    };
    const names = buildAtalkTaskTools({} as Agent, { workspaceDir: "/tmp" }).map(({ name }) => name);
    expect(manifest.contracts.tools).toEqual(names);
  });

  it("lists only a locally opened Task view instead of leaking encrypted envelopes", async () => {
    const task = detail();
    const agent = {
      workrooms: { list: vi.fn(async () => ({ workrooms: [task], nextCursor: null })) },
    } as unknown as Agent;
    const tools = buildAtalkTaskTools(agent, {});
    const list = tools.find(({ name }) => name === "atalk_task_list") as any;

    const result = await list.execute("call-1", {});
    const payload = result.details.tasks[0];

    expect(payload.descriptor.objective).toBe("Prepare the launch brief");
    expect(payload.workroom).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("descriptorEnvelope");
  });

  it("publishes an assigned plan with the stable plan.update action path", async () => {
    const task = detail();
    const publishMandated = vi.fn(async () => ({
      status: "requires_approval",
      requestIds: ["77777777-7777-4777-8777-777777777777"],
      decision: { status: "requires_approval", reason: "THRESHOLD", thresholdIds: ["owner"] },
    }));
    const agent = {
      workrooms: { get: vi.fn(async () => task), publishMandated },
    } as unknown as Agent;
    const tools = buildAtalkTaskTools(agent, {});
    const plan = tools.find(({ name }) => name === "atalk_task_plan") as any;

    const result = await plan.execute("call-2", {
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      planVersion: 1,
      summary: "Launch plan",
      steps: [{
        id: "draft",
        title: "Draft the brief",
        status: "executing",
        assignedHandles: ["@analysis.agent"],
      }],
    });

    expect(publishMandated).toHaveBeenCalledWith(expect.objectContaining({
      workroomId: WORKROOM_ID,
      threadId: THREAD_ID,
      payload: expect.objectContaining({
        kind: "plan",
        steps: [expect.objectContaining({ assignedPeerIds: [AGENT_ID] })],
      }),
    }));
    expect(result.details.operationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(result.details.result.status).toBe("requires_approval");
  });

  it("submits typed media only from the active workspace and exposes artifact ids", async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), "atalk-openclaw-tool-"));
    const path = join(workspaceDir, "voice.webm");
    await writeFile(path, new Uint8Array([1, 2, 3]));
    try {
      const submitFileMandated = vi.fn(async () => ({
        status: "executed",
        value: {
          descriptor: { id: ARTIFACT_VERSION_ID, mimeType: "audio/webm" },
          artifactId: ARTIFACT_ID,
          artifactVersion: 1,
          artifactVersionId: ARTIFACT_VERSION_ID,
          record: { event: { eventId: ARTIFACT_VERSION_ID } },
        },
      }));
      const agent = {
        workrooms: { get: vi.fn(async () => detail()), submitFileMandated },
      } as unknown as Agent;
      const tools = buildAtalkTaskTools(agent, { workspaceDir });
      const submit = tools.find(({ name }) => name === "atalk_task_submit_file") as any;

      const result = await submit.execute("call-file", {
        workroomId: WORKROOM_ID,
        threadId: THREAD_ID,
        filePath: "voice.webm",
        mimeType: "audio/webm",
        mentionHandles: ["@product.owner"],
      });

      expect(submitFileMandated).toHaveBeenCalledWith(expect.objectContaining({
        path: await realpath(path),
        mimeType: "audio/webm",
        mentions: [expect.objectContaining({ peerId: HUMAN_ID, peerType: "HUMAN" })],
      }));
      expect(result.details.result.value).toMatchObject({
        artifactId: ARTIFACT_ID,
        artifactVersion: 1,
        artifactVersionId: ARTIFACT_VERSION_ID,
      });
      await expect(submit.execute("call-outside", {
        workroomId: WORKROOM_ID,
        threadId: THREAD_ID,
        filePath: fileURLToPath(import.meta.url),
      })).rejects.toThrow("active OpenClaw workspace");
    } finally {
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});
