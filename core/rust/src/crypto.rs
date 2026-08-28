use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use crypto_box::{
    PublicKey, SalsaBox, SecretKey,
    aead::{Aead, AeadCore},
};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::OsRng;
use serde::Serialize;
use serde_json::Value;
use thiserror::Error;

use crate::types::{EncryptTextInput, EncryptedEnvelope, IdentityKeyPair};

#[derive(Debug, Error)]
pub enum CryptoError {
    #[error("invalid base64url value")]
    InvalidBase64(#[from] base64::DecodeError),
    #[error("invalid key length for {0}")]
    InvalidKeyLength(&'static str),
    #[error("unsupported envelope version or message type")]
    UnsupportedEnvelope,
    #[error("invalid envelope signature")]
    InvalidSignature,
    #[error("encryption failed")]
    EncryptionFailed,
    #[error("decryption failed")]
    DecryptionFailed,
    #[error("canonical serialization failed")]
    SerializationFailed(#[from] serde_json::Error),
    #[error("decrypted text is not UTF-8")]
    InvalidUtf8(#[from] std::string::FromUtf8Error),
}

pub fn generate_identity_keys() -> IdentityKeyPair {
    let signing = SigningKey::generate(&mut OsRng);
    let encryption = SecretKey::generate(&mut OsRng);
    IdentityKeyPair {
        signing_public_key: encode(signing.verifying_key().as_bytes()),
        signing_secret_key: encode(&signing.to_keypair_bytes()),
        encryption_public_key: encode(encryption.public_key().as_bytes()),
        encryption_secret_key: encode(&encryption.to_bytes()),
    }
}

pub fn encrypt_text(input: EncryptTextInput<'_>) -> Result<EncryptedEnvelope, CryptoError> {
    let signing_seed = signing_seed(input.sender_signing_secret_key)?;
    let signing = SigningKey::from_bytes(&signing_seed);
    let sender_secret = SecretKey::from(decode_array::<32>(
        input.sender_encryption_secret_key,
        "sender encryption secret key",
    )?);
    let recipient_public = PublicKey::from(decode_array::<32>(
        input.recipient_encryption_public_key,
        "recipient encryption public key",
    )?);
    let cipher = SalsaBox::new(&recipient_public, &sender_secret);
    let nonce_bytes = input
        .nonce
        .unwrap_or_else(|| SalsaBox::generate_nonce(&mut OsRng).into());
    let nonce = crypto_box::aead::generic_array::GenericArray::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, input.plaintext.as_bytes())
        .map_err(|_| CryptoError::EncryptionFailed)?;

    let mut envelope = EncryptedEnvelope {
        version: 1,
        message_id: input.message_id,
        conversation_id: input.conversation_id,
        sender_peer_id: input.sender_peer_id,
        recipient_peer_id: input.recipient_peer_id,
        timestamp: input.timestamp.to_owned(),
        message_type: "TEXT".to_owned(),
        nonce: encode(&nonce_bytes),
        ciphertext: encode(&ciphertext),
        signature: String::new(),
    };
    envelope.signature = encode(
        &signing
            .sign(&canonical_bytes(&envelope.unsigned())?)
            .to_bytes(),
    );
    Ok(envelope)
}

pub fn verify_envelope(
    envelope: &EncryptedEnvelope,
    sender_signing_public_key: &str,
) -> Result<(), CryptoError> {
    validate_envelope(envelope)?;
    let verifying_key = VerifyingKey::from_bytes(&decode_array::<32>(
        sender_signing_public_key,
        "sender signing public key",
    )?)
    .map_err(|_| CryptoError::InvalidKeyLength("sender signing public key"))?;
    let signature = Signature::from_bytes(&decode_array::<64>(&envelope.signature, "signature")?);
    verifying_key
        .verify(&canonical_bytes(&envelope.unsigned())?, &signature)
        .map_err(|_| CryptoError::InvalidSignature)
}

pub fn decrypt_text(
    envelope: &EncryptedEnvelope,
    sender_signing_public_key: &str,
    sender_encryption_public_key: &str,
    recipient_encryption_secret_key: &str,
) -> Result<String, CryptoError> {
    verify_envelope(envelope, sender_signing_public_key)?;
    let sender_public = PublicKey::from(decode_array::<32>(
        sender_encryption_public_key,
        "sender encryption public key",
    )?);
    let recipient_secret = SecretKey::from(decode_array::<32>(
        recipient_encryption_secret_key,
        "recipient encryption secret key",
    )?);
    let nonce_bytes = decode_array::<24>(&envelope.nonce, "nonce")?;
    let ciphertext = decode(&envelope.ciphertext)?;
    let cipher = SalsaBox::new(&sender_public, &recipient_secret);
    let plaintext = cipher
        .decrypt(
            crypto_box::aead::generic_array::GenericArray::from_slice(&nonce_bytes),
            ciphertext.as_ref(),
        )
        .map_err(|_| CryptoError::DecryptionFailed)?;
    Ok(String::from_utf8(plaintext)?)
}

fn validate_envelope(envelope: &EncryptedEnvelope) -> Result<(), CryptoError> {
    if envelope.version != 1 || envelope.message_type != "TEXT" {
        return Err(CryptoError::UnsupportedEnvelope);
    }
    let _ = decode_array::<24>(&envelope.nonce, "nonce")?;
    if decode(&envelope.ciphertext)?.len() < 16 {
        return Err(CryptoError::DecryptionFailed);
    }
    Ok(())
}

fn signing_seed(value: &str) -> Result<[u8; 32], CryptoError> {
    let decoded = decode(value)?;
    match decoded.len() {
        32 | 64 => decoded[..32]
            .try_into()
            .map_err(|_| CryptoError::InvalidKeyLength("signing secret key")),
        _ => Err(CryptoError::InvalidKeyLength("signing secret key")),
    }
}

fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let normalized = sort_json(serde_json::to_value(value)?);
    serde_json::to_vec(&normalized)
}

fn sort_json(value: Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.into_iter().map(sort_json).collect()),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_by(|left, right| left.0.cmp(&right.0));
            Value::Object(
                entries
                    .into_iter()
                    .map(|(key, value)| (key, sort_json(value)))
                    .collect(),
            )
        }
        primitive => primitive,
    }
}

fn encode(value: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(value)
}

fn decode(value: &str) -> Result<Vec<u8>, base64::DecodeError> {
    URL_SAFE_NO_PAD.decode(value)
}

fn decode_array<const N: usize>(value: &str, label: &'static str) -> Result<[u8; N], CryptoError> {
    decode(value)?
        .try_into()
        .map_err(|_| CryptoError::InvalidKeyLength(label))
}
