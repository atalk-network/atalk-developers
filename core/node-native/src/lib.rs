use atalk_core::EncryptedEnvelope;
use napi::bindgen_prelude::{Error, Result, Status};
use napi_derive::napi;

#[napi(js_name = "coreVersion")]
pub fn core_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[napi(js_name = "generateIdentityKeysJson")]
pub fn generate_identity_keys_json() -> Result<String> {
    atalk_core::bridge::generate_identity_keys_json().map_err(native_error)
}

#[napi(js_name = "encryptTextJson")]
pub fn encrypt_text_json(input_json: String) -> Result<String> {
    atalk_core::bridge::encrypt_text_json(&input_json).map_err(native_error)
}

#[napi(js_name = "decryptTextJson")]
pub fn decrypt_text_json(input_json: String) -> Result<String> {
    atalk_core::bridge::decrypt_text_json(&input_json).map_err(native_error)
}

#[napi(js_name = "verifyEnvelopeJson")]
pub fn verify_envelope_json(envelope_json: String, signing_public_key: String) -> Result<bool> {
    let envelope: EncryptedEnvelope = from_json(&envelope_json)?;
    let input = serde_json::json!({
        "envelope": envelope,
        "signingPublicKey": signing_public_key,
    });
    atalk_core::bridge::verify_envelope_json(&input.to_string()).map_err(native_error)
}

#[napi(js_name = "evaluatePermissionJson")]
pub fn evaluate_permission_json(context_json: String) -> Result<String> {
    atalk_core::bridge::evaluate_permission_json(&context_json).map_err(native_error)
}

fn from_json<T: serde::de::DeserializeOwned>(value: &str) -> Result<T> {
    serde_json::from_str(value).map_err(|error| invalid(error.to_string()))
}

fn invalid(reason: impl Into<String>) -> Error {
    Error::new(Status::InvalidArg, reason.into())
}

fn native_error(error: impl ToString) -> Error {
    Error::new(Status::GenericFailure, error.to_string())
}
