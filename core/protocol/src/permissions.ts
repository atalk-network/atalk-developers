import type {
  AgentPolicy,
  CommunicationScope,
  OrganizationPolicy,
  PermissionContext,
  PermissionDecision,
  PublicPeer,
} from "./types.js";

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  incoming: "OWNER_ONLY",
  outgoing: "OWNER_ONLY",
  selectedIncomingPeerIds: [],
  selectedOutgoingPeerIds: [],
  agentToAgentAllowed: false,
};

export const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = {
  humansCanContactExternal: true,
  agentsCanContactExternal: false,
  externalHumansCanContactAgents: "SELECTED_AGENTS",
  externallyReachableAgentIds: [],
  externalAgentsCanContactInternalAgents: false,
};

function belongsToOrganization(peer: PublicPeer, organizationId: string): boolean {
  return (
    peer.organizationId === organizationId ||
    peer.membershipOrganizationIds?.includes(organizationId) === true
  );
}

function scopeAllows(
  scope: CommunicationScope,
  agent: PublicPeer,
  counterpart: PublicPeer,
  selectedPeerIds: readonly string[],
): boolean {
  switch (scope) {
    case "OWNER_ONLY":
      return counterpart.id === agent.ownerPeerId;
    case "ORGANIZATION_ONLY":
      return agent.organizationId !== undefined && belongsToOrganization(counterpart, agent.organizationId);
    case "SELECTED_PEERS":
      return selectedPeerIds.includes(counterpart.id);
    case "NETWORK":
      return true;
  }
}

function isExternalTo(peer: PublicPeer, organizationId: string): boolean {
  return !belongsToOrganization(peer, organizationId);
}

export function evaluatePermission(context: PermissionContext): PermissionDecision {
  const { sender, recipient } = context;
  if (sender.status !== "ACTIVE" || recipient.status !== "ACTIVE") {
    return { allowed: false, code: "PEER_INACTIVE" };
  }
  if (context.senderBlockedRecipient || context.recipientBlockedSender) {
    return { allowed: false, code: "BLOCKED" };
  }

  if (sender.type === "AGENT" && recipient.type === "AGENT") {
    if (!context.senderAgentPolicy || !context.recipientAgentPolicy) {
      return { allowed: false, code: "POLICY_MISSING" };
    }
    if (!context.senderAgentPolicy.agentToAgentAllowed || !context.recipientAgentPolicy.agentToAgentAllowed) {
      return { allowed: false, code: "AGENT_TO_AGENT_DISABLED" };
    }
  }

  if (sender.type === "AGENT") {
    const policy = context.senderAgentPolicy;
    if (!policy) return { allowed: false, code: "POLICY_MISSING" };
    if (!scopeAllows(policy.outgoing, sender, recipient, policy.selectedOutgoingPeerIds)) {
      return { allowed: false, code: "OUTGOING_SCOPE_DENIED" };
    }
    if (sender.organizationId && isExternalTo(recipient, sender.organizationId)) {
      if (!context.senderOrganizationPolicy?.agentsCanContactExternal) {
        return { allowed: false, code: "ORGANIZATION_OUTGOING_DENIED" };
      }
    }
  }

  if (recipient.type === "AGENT") {
    const policy = context.recipientAgentPolicy;
    if (!policy) return { allowed: false, code: "POLICY_MISSING" };
    if (!scopeAllows(policy.incoming, recipient, sender, policy.selectedIncomingPeerIds)) {
      return { allowed: false, code: "INCOMING_SCOPE_DENIED" };
    }

    if (recipient.organizationId && isExternalTo(sender, recipient.organizationId)) {
      const organizationPolicy = context.recipientOrganizationPolicy;
      if (!organizationPolicy) return { allowed: false, code: "POLICY_MISSING" };
      if (sender.type === "AGENT" && !organizationPolicy.externalAgentsCanContactInternalAgents) {
        return { allowed: false, code: "ORGANIZATION_INCOMING_DENIED" };
      }
      if (sender.type === "HUMAN") {
        const mode = organizationPolicy.externalHumansCanContactAgents;
        if (mode === "NONE") return { allowed: false, code: "ORGANIZATION_INCOMING_DENIED" };
        if (mode === "SELECTED_AGENTS" && !organizationPolicy.externallyReachableAgentIds.includes(recipient.id)) {
          return { allowed: false, code: "ORGANIZATION_INCOMING_DENIED" };
        }
      }
    }
  }

  return { allowed: true };
}
