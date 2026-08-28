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

const organizationAgent = (id: string, organizationId: string): PublicPeer => ({
  id,
  type: "AGENT",
  status: "ACTIVE",
  handle: `@agent.${id.slice(0, 2)}`,
  displayName: "Agent",
  signingPublicKey: "key",
  encryptionPublicKey: "key",
  organizationId,
});

const personalAgent = (id: string, personalOwnerPeerId: string): PublicPeer => ({
  id,
  type: "AGENT",
  status: "ACTIVE",
  handle: `@agent.${id.slice(0, 2)}`,
  displayName: "Agent",
  signingPublicKey: "key",
  encryptionPublicKey: "key",
  personalOwnerPeerId,
});

describe("permission intersection", () => {
  it("allows an organization member to message an organization-only agent", () => {
    const organizationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sender = human("11111111-1111-4111-8111-111111111111", [organizationId]);
    const recipient = organizationAgent("22222222-2222-4222-8222-222222222222", organizationId);
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
    const sales = organizationAgent(
      "22222222-2222-4222-8222-222222222222",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    const finance = organizationAgent(
      "33333333-3333-4333-8333-333333333333",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
    const recipient = organizationAgent(
      "22222222-2222-4222-8222-222222222222",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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

  it("matches OWNER_ONLY only for the explicit personal owner", () => {
    const owner = human("11111111-1111-4111-8111-111111111111");
    const recipient = personalAgent("22222222-2222-4222-8222-222222222222", owner.id);
    expect(evaluatePermission({
      sender: owner,
      recipient,
      recipientAgentPolicy: DEFAULT_AGENT_POLICY,
    })).toEqual({ allowed: true });
  });

  it("does not treat an organization agent creator as its owner", () => {
    const creator = human("11111111-1111-4111-8111-111111111111");
    const recipient = organizationAgent(
      "22222222-2222-4222-8222-222222222222",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
    expect(evaluatePermission({
      sender: creator,
      recipient,
      recipientAgentPolicy: DEFAULT_AGENT_POLICY,
      recipientOrganizationPolicy: DEFAULT_ORGANIZATION_POLICY,
    })).toEqual({ allowed: false, code: "INCOMING_SCOPE_DENIED" });
  });
});
