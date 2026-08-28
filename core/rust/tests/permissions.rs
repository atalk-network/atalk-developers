use atalk_core::{
    AgentPolicy, CommunicationScope, PeerStatus, PeerType, PermissionContext, PermissionDecision,
    PermissionDeniedCode, PublicPeer, evaluate_permission,
};
use uuid::Uuid;

fn peer(peer_type: PeerType) -> PublicPeer {
    PublicPeer {
        id: Uuid::new_v4(),
        peer_type,
        status: PeerStatus::Active,
        handle: "@peer".into(),
        display_name: "Peer".into(),
        signing_public_key: "key".into(),
        encryption_public_key: "key".into(),
        organization_id: None,
        owner_peer_id: None,
        membership_organization_ids: None,
    }
}

fn network_policy(agent_to_agent_allowed: bool) -> AgentPolicy {
    AgentPolicy {
        incoming: CommunicationScope::Network,
        outgoing: CommunicationScope::Network,
        selected_incoming_peer_ids: vec![],
        selected_outgoing_peer_ids: vec![],
        agent_to_agent_allowed,
    }
}

#[test]
fn both_agents_must_opt_in_to_agent_to_agent_messages() {
    let sender = peer(PeerType::Agent);
    let recipient = peer(PeerType::Agent);
    let sender_policy = network_policy(true);
    let recipient_policy = network_policy(false);
    assert_eq!(
        evaluate_permission(&PermissionContext {
            sender: &sender,
            recipient: &recipient,
            sender_agent_policy: Some(&sender_policy),
            recipient_agent_policy: Some(&recipient_policy),
            sender_organization_policy: None,
            recipient_organization_policy: None,
            sender_blocked_recipient: false,
            recipient_blocked_sender: false,
        }),
        PermissionDecision::Denied(PermissionDeniedCode::AgentToAgentDisabled),
    );
}

#[test]
fn a_block_always_wins() {
    let sender = peer(PeerType::Human);
    let recipient = peer(PeerType::Human);
    assert_eq!(
        evaluate_permission(&PermissionContext {
            sender: &sender,
            recipient: &recipient,
            sender_agent_policy: None,
            recipient_agent_policy: None,
            sender_organization_policy: None,
            recipient_organization_policy: None,
            sender_blocked_recipient: true,
            recipient_blocked_sender: false,
        }),
        PermissionDecision::Denied(PermissionDeniedCode::Blocked),
    );
}
