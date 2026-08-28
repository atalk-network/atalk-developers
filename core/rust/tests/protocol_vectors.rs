use atalk_core::{
    EncryptTextInput, EncryptedEnvelope, decrypt_text, encrypt_text, verify_envelope,
};
use pretty_assertions::assert_eq;
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
struct Vector {
    plaintext: String,
    sender_signing_public_key: String,
    sender_signing_secret_seed: String,
    sender_encryption_public_key: String,
    sender_encryption_secret_key: String,
    recipient_encryption_secret_key: String,
    recipient_encryption_public_key: String,
    envelope: EncryptedEnvelope,
}

fn vector() -> Vector {
    serde_json::from_str(include_str!("../../protocol/test-vectors/v1.json"))
        .expect("valid shared protocol vector")
}

#[test]
fn decrypts_and_verifies_the_typescript_vector() {
    let vector = vector();
    verify_envelope(&vector.envelope, &vector.sender_signing_public_key)
        .expect("signature should verify");
    assert_eq!(
        decrypt_text(
            &vector.envelope,
            &vector.sender_signing_public_key,
            &vector.sender_encryption_public_key,
            &vector.recipient_encryption_secret_key,
        )
        .expect("ciphertext should decrypt"),
        vector.plaintext,
    );
}

#[test]
fn reproduces_the_typescript_envelope_byte_for_byte() {
    let vector = vector();
    let actual = encrypt_text(EncryptTextInput {
        message_id: Uuid::parse_str("11111111-1111-4111-8111-111111111111").unwrap(),
        conversation_id: Uuid::parse_str("22222222-2222-4222-8222-222222222222").unwrap(),
        sender_peer_id: Uuid::parse_str("33333333-3333-4333-8333-333333333333").unwrap(),
        recipient_peer_id: Uuid::parse_str("44444444-4444-4444-8444-444444444444").unwrap(),
        timestamp: "2026-08-28T12:00:00.000Z",
        plaintext: &vector.plaintext,
        sender_signing_secret_key: &vector.sender_signing_secret_seed,
        sender_encryption_secret_key: &vector.sender_encryption_secret_key,
        recipient_encryption_public_key: &vector.recipient_encryption_public_key,
        nonce: Some([
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
        ]),
    })
    .expect("encryption should succeed");
    assert_eq!(actual, vector.envelope);
}
