import { describe, expect, it } from "vitest";
import { DEFAULT_AGENT_POLICY, DEFAULT_ORGANIZATION_POLICY, evaluatePermission } from "./permissions.js";
import type { PublicPeer } from "./types.js";

const human = (id: string, organizations: string[] = []): PublicPeer => ({
  id,
  type: "HUMAN",
  status: "ACTIVE",
  handle: `@human.${id.slice(0, 2)}`,
  displayName: "Human",
  signingPublicKey: "key",
  encryptionPublicKey: "key",
  membershipOrganizationIds: organizations,
});

const agent = (id: string, organizationId: string, ownerPeerId: string): PublicPeer => ({
  id,
  type: "AGENT",
  status: "ACTIVE",
  handle: `@agent.${id.slice(0, 2)}`,
  displayName: "Agent",
  signingPublicKey: "key",
  encryptionPublicKey: "key",
  organizationId,
  ownerPeerId,
});

describe("permission intersection", () => {
  it("allows an organization member to message an organization-only agent", () => {
    const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sender = human("11111111-1111-4111-8111-111111111111", [organizationId]);
    const recipient = agent("22222222-2222-4222-8222-222222222222", organizationId, sender.id);
    expect(
      evaluatePermission({
        sender,
        recipient,
        recipientAgentPolicy: { ...DEFAULT_AGENT_POLICY, incoming: "ORGANIZATION_ONLY" },
        recipientOrganizationPolicy: DEFAULT_ORGANIZATION_POLICY,
      }),
    ).toEqual({ allowed: true });
  });

  it("requires the organization to allow external agent traffic", () => {
    const sales = agent(
      "22222222-2222-4222-8222-222222222222",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "11111111-1111-4111-8111-111111111111",
    );
    const finance = agent(
      "33333333-3333-4333-8333-333333333333",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      "44444444-4444-4444-8444-444444444444",
    );
    const openAgent = {
      ...DEFAULT_AGENT_POLICY,
      incoming: "NETWORK" as const,
      outgoing: "NETWORK" as const,
      agentToAgentAllowed: true,
    };
    expect(
      evaluatePermission({
        sender: sales,
        recipient: finance,
        senderAgentPolicy: openAgent,
        recipientAgentPolicy: openAgent,
        senderOrganizationPolicy: DEFAULT_ORGANIZATION_POLICY,
        recipientOrganizationPolicy: DEFAULT_ORGANIZATION_POLICY,
      }),
    ).toEqual({ allowed: false, code: "ORGANIZATION_OUTGOING_DENIED" });
  });

  it("denies a blocked peer before broader network policy", () => {
    const sender = human("11111111-1111-4111-8111-111111111111");
    const recipient = agent(
      "22222222-2222-4222-8222-222222222222",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "33333333-3333-4333-8333-333333333333",
    );
    expect(
      evaluatePermission({
        sender,
        recipient,
        recipientAgentPolicy: { ...DEFAULT_AGENT_POLICY, incoming: "NETWORK" },
        recipientOrganizationPolicy: {
          ...DEFAULT_ORGANIZATION_POLICY,
          externalHumansCanContactAgents: "ALL",
        },
        recipientBlockedSender: true,
      }),
    ).toEqual({ allowed: false, code: "BLOCKED" });
  });
});
