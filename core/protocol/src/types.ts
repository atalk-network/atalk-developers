export const PEER_TYPES = ["HUMAN", "AGENT", "ORGANIZATION"] as const;
export type PeerType = (typeof PEER_TYPES)[number];

export const PEER_STATUSES = ["PENDING", "ACTIVE", "REVOKED"] as const;
export type PeerStatus = (typeof PEER_STATUSES)[number];

export const MESSAGE_STATES = [
  "CREATED",
  "QUEUED",
  "SENT",
  "DELIVERED",
  "READ",
  "FAILED",
] as const;
export type MessageState = (typeof MESSAGE_STATES)[number];

export const COMMUNICATION_SCOPES = [
  "OWNER_ONLY",
  "ORGANIZATION_ONLY",
  "SELECTED_PEERS",
  "NETWORK",
] as const;
export type CommunicationScope = (typeof COMMUNICATION_SCOPES)[number];

export interface PublicPeer {
  id: string;
  type: PeerType;
  status: PeerStatus;
  handle: string;
  displayName: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  organizationId?: string;
  ownerPeerId?: string;
  membershipOrganizationIds?: string[];
}

export interface IdentityKeyPair {
  signingPublicKey: string;
  signingSecretKey: string;
  encryptionPublicKey: string;
  encryptionSecretKey: string;
}

export interface AgentPolicy {
  incoming: CommunicationScope;
  outgoing: CommunicationScope;
  selectedIncomingPeerIds: readonly string[];
  selectedOutgoingPeerIds: readonly string[];
  agentToAgentAllowed: boolean;
}

export interface OrganizationPolicy {
  humansCanContactExternal: boolean;
  agentsCanContactExternal: boolean;
  externalHumansCanContactAgents: "NONE" | "SELECTED_AGENTS" | "ALL";
  externallyReachableAgentIds: readonly string[];
  externalAgentsCanContactInternalAgents: boolean;
}

export interface PermissionContext {
  sender: PublicPeer;
  recipient: PublicPeer;
  senderAgentPolicy?: AgentPolicy;
  recipientAgentPolicy?: AgentPolicy;
  senderOrganizationPolicy?: OrganizationPolicy;
  recipientOrganizationPolicy?: OrganizationPolicy;
  senderBlockedRecipient?: boolean;
  recipientBlockedSender?: boolean;
}

export type PermissionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "PEER_INACTIVE"
        | "BLOCKED"
        | "AGENT_TO_AGENT_DISABLED"
        | "OUTGOING_SCOPE_DENIED"
        | "INCOMING_SCOPE_DENIED"
        | "ORGANIZATION_OUTGOING_DENIED"
        | "ORGANIZATION_INCOMING_DENIED"
        | "POLICY_MISSING";
    };
