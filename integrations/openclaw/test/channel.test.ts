import type { OpenClawConfig } from "openclaw/plugin-sdk/channel-core";
import { afterEach, describe, expect, it } from "vitest";
import { atalkPlugin, normalizeAtalkTarget, resolveAtalkAccount } from "../src/channel.js";

describe("OpenClaw aTalk channel", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it("normalizes aTalk targets", () => {
    expect(normalizeAtalkTarget("atalk:sales.demo")).toBe("@sales.demo");
    expect(normalizeAtalkTarget("@research.demo")).toBe("@research.demo");
  });

  it("uses a one-time token with a durable default credential path", () => {
    process.env.ATALK_AGENT_TOKEN = "one-time";
    delete process.env.ATALK_CREDENTIAL_PATH;
    const account = resolveAtalkAccount({} as OpenClawConfig, "default");
    expect(account).toMatchObject({
      accountId: "default",
      configured: true,
      baseUrl: "https://api.atalk.ar",
      token: "one-time",
    });
    expect(account.credentialPath).toContain(".atalk/openclaw-agent.json");
  });

  it("declares direct chats and encrypted multi-participant Tasks", () => {
    expect(atalkPlugin.id).toBe("atalk");
    expect(atalkPlugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(atalkPlugin.outbound?.deliveryMode).toBe("direct");
  });
});
