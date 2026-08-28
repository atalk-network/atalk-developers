//! JSON boundary shared by native language bindings.
//!
//! Keeping this adapter inside the core makes the N-API, Swift and Kotlin
//! bridges deliberately thin and gives every runtime the same validation.

use serde::Deserialize;
use serde_json::json;
use thiserror::Error;
use uuid::Uuid;

use crate::{
    AgentPolicy, EncryptTextInput, EncryptedEnvelope, OrganizationPolicy, PermissionContext,
    PermissionDecision, PublicPeer,
};

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("invalid bridge JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("nonce must contain exactly 24 bytes")]
    InvalidNonce,
    #[error(transparent)]
    Crypto(#[from] crate::CryptoError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedEncryptTextInput {
    message_id: Uuid,
    conversation_id: Uuid,
    sender_peer_id: Uuid,
    recipient_peer_id: Uuid,
    timestamp: String,
    plaintext: String,
    sender_signing_secret_key: String,
    sender_encryption_secret_key: String,
    recipient_encryption_public_key: String,
    nonce: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedDecryptTextInput {
    envelope: EncryptedEnvelope,
    sender_signing_public_key: String,
    sender_encryption_public_key: String,
    recipient_encryption_secret_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifyEnvelopeInput {
    envelope: EncryptedEnvelope,
    signing_public_key: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OwnedPermissionContext {
    sender: PublicPeer,
    recipient: PublicPeer,
    sender_agent_policy: Option<AgentPolicy>,
    recipient_agent_policy: Option<AgentPolicy>,
    sender_organization_policy: Option<OrganizationPolicy>,
    recipient_organization_policy: Option<OrganizationPolicy>,
    #[serde(default)]
    sender_blocked_recipient: bool,
    #[serde(default)]
    recipient_blocked_sender: bool,
}

pub fn generate_identity_keys_json() -> Result<String, BridgeError> {
    Ok(serde_json::to_string(&crate::generate_identity_keys())?)
}

pub fn encrypt_text_json(input_json: &str) -> Result<String, BridgeError> {
    let input: OwnedEncryptTextInput = serde_json::from_str(input_json)?;
    let nonce = input
        .nonce
        .map(|value| value.try_into().map_err(|_| BridgeError::InvalidNonce))
        .transpose()?;
    let envelope = crate::encrypt_text(EncryptTextInput {
        message_id: input.message_id,
        conversation_id: input.conversation_id,
        sender_peer_id: input.sender_peer_id,
        recipient_peer_id: input.recipient_peer_id,
        timestamp: &input.timestamp,
        plaintext: &input.plaintext,
        sender_signing_secret_key: &input.sender_signing_secret_key,
        sender_encryption_secret_key: &input.sender_encryption_secret_key,
        recipient_encryption_public_key: &input.recipient_encryption_public_key,
        nonce,
    })?;
    Ok(serde_json::to_string(&envelope)?)
}

pub fn decrypt_text_json(input_json: &str) -> Result<String, BridgeError> {
    let input: OwnedDecryptTextInput = serde_json::from_str(input_json)?;
    Ok(crate::decrypt_text(
        &input.envelope,
        &input.sender_signing_public_key,
        &input.sender_encryption_public_key,
        &input.recipient_encryption_secret_key,
    )?)
}

pub fn verify_envelope_json(input_json: &str) -> Result<bool, BridgeError> {
    let input: VerifyEnvelopeInput = serde_json::from_str(input_json)?;
    Ok(crate::verify_envelope(&input.envelope, &input.signing_public_key).is_ok())
}

pub fn evaluate_permission_json(context_json: &str) -> Result<String, BridgeError> {
    let owned: OwnedPermissionContext = serde_json::from_str(context_json)?;
    let decision = crate::evaluate_permission(&PermissionContext {
        sender: &owned.sender,
        recipient: &owned.recipient,
        sender_agent_policy: owned.sender_agent_policy.as_ref(),
        recipient_agent_policy: owned.recipient_agent_policy.as_ref(),
        sender_organization_policy: owned.sender_organization_policy.as_ref(),
        recipient_organization_policy: owned.recipient_organization_policy.as_ref(),
        sender_blocked_recipient: owned.sender_blocked_recipient,
        recipient_blocked_sender: owned.recipient_blocked_sender,
    });
    Ok(match decision {
        PermissionDecision::Allowed => json!({ "allowed": true }).to_string(),
        PermissionDecision::Denied(code) => json!({ "allowed": false, "code": code }).to_string(),
    })
}
