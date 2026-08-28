//! Portable implementation of the aTalk v1 protocol core.
//!
//! This crate intentionally contains no networking or persistence. Mobile,
//! server and SDK adapters can share its deterministic wire and policy rules.

pub mod bridge;
pub mod crypto;
pub mod permissions;
pub mod types;

pub use crypto::{
    CryptoError, decrypt_text, encrypt_text, generate_identity_keys, verify_envelope,
};
pub use permissions::{DEFAULT_AGENT_POLICY, DEFAULT_ORGANIZATION_POLICY, evaluate_permission};
pub use types::*;
