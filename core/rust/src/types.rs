use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerType {
    Human,
    Agent,
    Organization,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PeerStatus {
    Pending,
    Active,
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CommunicationScope {
    OwnerOnly,
    OrganizationOnly,
    SelectedPeers,
    Network,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicPeer {
    pub id: Uuid,
    #[serde(rename = "type")]
    pub peer_type: PeerType,
    pub status: PeerStatus,
    pub handle: String,
    pub display_name: String,
    pub signing_public_key: String,
    pub encryption_public_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_peer_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub membership_organization_ids: Option<Vec<Uuid>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityKeyPair {
    pub signing_public_key: String,
    pub signing_secret_key: String,
    pub encryption_public_key: String,
    pub encryption_secret_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPolicy {
    pub incoming: CommunicationScope,
    pub outgoing: CommunicationScope,
    pub selected_incoming_peer_ids: Vec<Uuid>,
    pub selected_outgoing_peer_ids: Vec<Uuid>,
    pub agent_to_agent_allowed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ExternalHumanAccess {
    None,
    SelectedAgents,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationPolicy {
    pub humans_can_contact_external: bool,
    pub agents_can_contact_external: bool,
    pub external_humans_can_contact_agents: ExternalHumanAccess,
    pub externally_reachable_agent_ids: Vec<Uuid>,
    pub external_agents_can_contact_internal_agents: bool,
}

#[derive(Debug, Clone)]
pub struct PermissionContext<'a> {
    pub sender: &'a PublicPeer,
    pub recipient: &'a PublicPeer,
    pub sender_agent_policy: Option<&'a AgentPolicy>,
    pub recipient_agent_policy: Option<&'a AgentPolicy>,
    pub sender_organization_policy: Option<&'a OrganizationPolicy>,
    pub recipient_organization_policy: Option<&'a OrganizationPolicy>,
    pub sender_blocked_recipient: bool,
    pub recipient_blocked_sender: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PermissionDeniedCode {
    PeerInactive,
    Blocked,
    AgentToAgentDisabled,
    OutgoingScopeDenied,
    IncomingScopeDenied,
    OrganizationOutgoingDenied,
    OrganizationIncomingDenied,
    PolicyMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionDecision {
    Allowed,
    Denied(PermissionDeniedCode),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UnsignedEnvelope {
    pub version: u8,
    pub message_id: Uuid,
    pub conversation_id: Uuid,
    pub sender_peer_id: Uuid,
    pub recipient_peer_id: Uuid,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedEnvelope {
    pub version: u8,
    pub message_id: Uuid,
    pub conversation_id: Uuid,
    pub sender_peer_id: Uuid,
    pub recipient_peer_id: Uuid,
    pub timestamp: String,
    #[serde(rename = "type")]
    pub message_type: String,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
}

impl EncryptedEnvelope {
    pub fn unsigned(&self) -> UnsignedEnvelope {
        UnsignedEnvelope {
            version: self.version,
            message_id: self.message_id,
            conversation_id: self.conversation_id,
            sender_peer_id: self.sender_peer_id,
            recipient_peer_id: self.recipient_peer_id,
            timestamp: self.timestamp.clone(),
            message_type: self.message_type.clone(),
            nonce: self.nonce.clone(),
            ciphertext: self.ciphertext.clone(),
        }
    }
}

pub struct EncryptTextInput<'a> {
    pub message_id: Uuid,
    pub conversation_id: Uuid,
    pub sender_peer_id: Uuid,
    pub recipient_peer_id: Uuid,
    pub timestamp: &'a str,
    pub plaintext: &'a str,
    pub sender_signing_secret_key: &'a str,
    pub sender_encryption_secret_key: &'a str,
    pub recipient_encryption_public_key: &'a str,
    pub nonce: Option<[u8; 24]>,
}
