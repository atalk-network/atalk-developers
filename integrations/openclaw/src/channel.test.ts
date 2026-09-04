import type { IncomingMessage } from "@atalk/sdk";
import { describe, expect, it } from "vitest";
import {
  atalkPlugin,
  mandateFailureMode,
  mediaKind,
  normalizeAtalkTarget,
  renderWorkroomEvent,
  shouldDispatchWorkroomEvent,
  shouldRelaySupervisorMessage,
} from "./channel.js";

function messageWithMime(mimeType: string): IncomingMessage {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    conversationId: "22222222-2222-4222-8222-222222222222",
    text: "",
    sender: { id: "33333333-3333-4333-8333-333333333333", type: "HUMAN", handle: "@sender", displayName: "Sender" },
    receivedAt: new Date(0),
    isSupervisor: false,
    mentions: [],
    isMentioned: false,
    routing: { mode: "REPLY", targetHandle: "@sender" },
    markRead: async () => undefined,
    reply: async () => "44444444-4444-4444-8444-444444444444",
    relay: async () => "55555555-5555-4555-8555-555555555555",
    replyAttachment: async () => "66666666-6666-4666-8666-666666666666",
    replyAttachmentFile: async () => "77777777-7777-4777-8777-777777777777",
    relayAttachment: async () => "88888888-8888-4888-8888-888888888888",
    relayAttachmentFile: async () => "99999999-9999-4999-8999-999999999999",
    attachment: {
      descriptor: {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        kind: "FILE",
        name: "voice-message.m4a",
        mimeType,
        size: 4,
        sha256: "A".repeat(43),
        encryption: { algorithm: "XCHACHA20_POLY1305", key: "A".repeat(43), nonce: "A".repeat(32) },
      },
      download: async () => new Uint8Array([1, 2, 3, 4]),
      downloadTo: async (path) => path,
    },
  };
}

describe("aTalk OpenClaw channel", () => {
  it("advertises multimedia support and normalizes handles", () => {
    expect(atalkPlugin.capabilities.media).toBe(true);
    expect(atalkPlugin.capabilities.chatTypes).toContain("group");
    expect(normalizeAtalkTarget("atalk:voice.agent")).toBe("@voice.agent");
  });

  it("renders only this agent's executable Task steps", () => {
    const ownStep = {
      id: "research",
      title: "Compare public sources",
      status: "executing" as const,
      assignedPeerIds: ["33333333-3333-4333-8333-333333333333"],
      dependsOnStepIds: [],
    };
    const rendered = renderWorkroomEvent({ content: {
      version: 1,
      kind: "plan",
      planVersion: 1,
      summary: "Prepare the market report",
      steps: [ownStep, {
        id: "sales",
        title: "Negotiate the contract",
        status: "executing",
        assignedPeerIds: ["44444444-4444-4444-8444-444444444444"],
        dependsOnStepIds: [],
      }],
    }, routing: { directedToMe: true, directMentions: [], assignedSteps: [ownStep] } });
    expect(rendered).toContain("Compare public sources");
    expect(rendered).not.toContain("Negotiate the contract");
  });

  it("starts a Task turn only for the agent selected by structured routing", () => {
    const directed = { directedToMe: true, directMentions: [], assignedSteps: [] };
    const undirected = { directedToMe: false, directMentions: [], assignedSteps: [] };
    expect(shouldDispatchWorkroomEvent({ directedToMe: true, routing: directed })).toBe(true);
    expect(shouldDispatchWorkroomEvent({ directedToMe: false, routing: undirected })).toBe(false);
    expect(shouldDispatchWorkroomEvent({ directedToMe: true, routing: undirected })).toBe(false);
    // Plain-text @names are intentionally irrelevant here: the SDK derives
    // this bit only from authenticated mentions/assignments by peer id.
    expect(shouldDispatchWorkroomEvent({ directedToMe: false, routing: undirected })).toBe(false);
  });

  it("classifies encrypted voice notes as audio media", () => {
    expect(mediaKind(messageWithMime("audio/mp4"))).toBe("audio");
    expect(mediaKind(messageWithMime("audio/webm"))).toBe("audio");
  });

  it("obeys the SDK routing decision for supervisor responses", () => {
    expect(shouldRelaySupervisorMessage({ routing: { mode: "REPLY", targetHandle: "@owner" } })).toBe(false);
    expect(shouldRelaySupervisorMessage({ routing: { mode: "RELAY", targetHandle: "@counterparty" } })).toBe(true);
    expect(shouldRelaySupervisorMessage({ routing: { mode: "RELAY", targetHandle: "" } })).toBe(false);
  });

  it("retries approval waits without poisoning the poll loop on terminal denial", () => {
    expect(mandateFailureMode({ status: "requires_approval" })).toBe("retry");
    expect(mandateFailureMode({ status: "denied" })).toBe("stop");
    expect(mandateFailureMode({ status: "executed" })).toBeUndefined();
  });
});
