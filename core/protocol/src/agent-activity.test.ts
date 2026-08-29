import { describe, expect, it } from "vitest";
import { decodeAgentActivity, encodeAgentActivity } from "./agent-activity.js";

describe("agent activity payload", () => {
  it("round-trips structured supervised activity and ignores ordinary text", () => {
    const activity = {
      version: 1 as const,
      kind: "AGENT_ACTIVITY" as const,
      agentPeerId: "11111111-1111-4111-8111-111111111111",
      agentHandle: "@research.personal",
      counterpartyPeerId: "22222222-2222-4222-8222-222222222222",
      counterpartyHandle: "@ventas.acme",
      counterpartyDisplayName: "Ventas Acme",
      direction: "OUTGOING" as const,
      sourceMessageId: "33333333-3333-4333-8333-333333333333",
      observedAt: "2026-08-28T22:00:00.000Z",
      text: "Necesitamos una propuesta.",
    };
    expect(decodeAgentActivity(encodeAgentActivity(activity))).toEqual(activity);
    expect(decodeAgentActivity("Hola")).toBeUndefined();
    expect(decodeAgentActivity("__ATALK_AGENT_ACTIVITY_V1__invalid")).toBeUndefined();
  });
});
