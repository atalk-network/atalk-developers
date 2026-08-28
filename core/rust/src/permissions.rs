use crate::types::{
    AgentPolicy, CommunicationScope, ExternalHumanAccess, OrganizationPolicy, PeerType,
    PermissionContext, PermissionDecision, PermissionDeniedCode, PublicPeer,
};
use uuid::Uuid;

pub const DEFAULT_AGENT_POLICY: AgentPolicy = AgentPolicy {
    incoming: CommunicationScope::OwnerOnly,
    outgoing: CommunicationScope::OwnerOnly,
    selected_incoming_peer_ids: Vec::new(),
    selected_outgoing_peer_ids: Vec::new(),
    agent_to_agent_allowed: false,
};

pub const DEFAULT_ORGANIZATION_POLICY: OrganizationPolicy = OrganizationPolicy {
    humans_can_contact_external: true,
    agents_can_contact_external: false,
    external_humans_can_contact_agents: ExternalHumanAccess::SelectedAgents,
    externally_reachable_agent_ids: Vec::new(),
    external_agents_can_contact_internal_agents: false,
};

fn belongs_to_organization(peer: &PublicPeer, organization_id: Uuid) -> bool {
    peer.organization_id == Some(organization_id)
        || peer
            .membership_organization_ids
            .as_ref()
            .is_some_and(|memberships| memberships.contains(&organization_id))
}

fn scope_allows(
    scope: CommunicationScope,
    agent: &PublicPeer,
    counterpart: &PublicPeer,
    selected_peer_ids: &[Uuid],
) -> bool {
    match scope {
        CommunicationScope::OwnerOnly => agent.owner_peer_id == Some(counterpart.id),
        CommunicationScope::OrganizationOnly => agent
            .organization_id
            .is_some_and(|organization_id| belongs_to_organization(counterpart, organization_id)),
        CommunicationScope::SelectedPeers => selected_peer_ids.contains(&counterpart.id),
        CommunicationScope::Network => true,
    }
}

fn is_external_to(peer: &PublicPeer, organization_id: Uuid) -> bool {
    !belongs_to_organization(peer, organization_id)
}

pub fn evaluate_permission(context: &PermissionContext<'_>) -> PermissionDecision {
    use PermissionDecision::{Allowed, Denied};
    use PermissionDeniedCode::*;

    let sender = context.sender;
    let recipient = context.recipient;
    if sender.status != crate::types::PeerStatus::Active
        || recipient.status != crate::types::PeerStatus::Active
    {
        return Denied(PeerInactive);
    }
    if context.sender_blocked_recipient || context.recipient_blocked_sender {
        return Denied(Blocked);
    }

    if sender.peer_type == PeerType::Agent && recipient.peer_type == PeerType::Agent {
        let (Some(sender_policy), Some(recipient_policy)) =
            (context.sender_agent_policy, context.recipient_agent_policy)
        else {
            return Denied(PolicyMissing);
        };
        if !sender_policy.agent_to_agent_allowed || !recipient_policy.agent_to_agent_allowed {
            return Denied(AgentToAgentDisabled);
        }
    }

    if sender.peer_type == PeerType::Agent {
        let Some(policy) = context.sender_agent_policy else {
            return Denied(PolicyMissing);
        };
        if !scope_allows(
            policy.outgoing,
            sender,
            recipient,
            &policy.selected_outgoing_peer_ids,
        ) {
            return Denied(OutgoingScopeDenied);
        }
        if let Some(organization_id) = sender.organization_id
            && is_external_to(recipient, organization_id)
            && !context
                .sender_organization_policy
                .is_some_and(|policy| policy.agents_can_contact_external)
        {
            return Denied(OrganizationOutgoingDenied);
        }
    }

    if recipient.peer_type == PeerType::Agent {
        let Some(policy) = context.recipient_agent_policy else {
            return Denied(PolicyMissing);
        };
        if !scope_allows(
            policy.incoming,
            recipient,
            sender,
            &policy.selected_incoming_peer_ids,
        ) {
            return Denied(IncomingScopeDenied);
        }

        if let Some(organization_id) = recipient.organization_id
            && is_external_to(sender, organization_id)
        {
            let Some(organization_policy) = context.recipient_organization_policy else {
                return Denied(PolicyMissing);
            };
            if sender.peer_type == PeerType::Agent
                && !organization_policy.external_agents_can_contact_internal_agents
            {
                return Denied(OrganizationIncomingDenied);
            }
            if sender.peer_type == PeerType::Human {
                match organization_policy.external_humans_can_contact_agents {
                    ExternalHumanAccess::None => return Denied(OrganizationIncomingDenied),
                    ExternalHumanAccess::SelectedAgents
                        if !organization_policy
                            .externally_reachable_agent_ids
                            .contains(&recipient.id) =>
                    {
                        return Denied(OrganizationIncomingDenied);
                    }
                    _ => {}
                }
            }
        }
    }

    Allowed
}
