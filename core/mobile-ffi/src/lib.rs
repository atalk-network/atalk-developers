use std::{
    ffi::{CStr, CString, c_char},
    panic::{AssertUnwindSafe, catch_unwind},
};

use serde_json::json;

fn dispatch(operation: &str, input: &str) -> Result<String, String> {
    match operation {
        "coreVersion" => Ok(env!("CARGO_PKG_VERSION").to_owned()),
        "generateIdentityKeys" => {
            atalk_core::bridge::generate_identity_keys_json().map_err(|error| error.to_string())
        }
        "encryptText" => {
            atalk_core::bridge::encrypt_text_json(input).map_err(|error| error.to_string())
        }
        "decryptText" => {
            atalk_core::bridge::decrypt_text_json(input).map_err(|error| error.to_string())
        }
        "verifyEnvelope" => atalk_core::bridge::verify_envelope_json(input)
            .map(|valid| valid.to_string())
            .map_err(|error| error.to_string()),
        "evaluatePermission" => {
            atalk_core::bridge::evaluate_permission_json(input).map_err(|error| error.to_string())
        }
        _ => Err(format!("unknown core operation: {operation}")),
    }
}

fn call_json(operation: &str, input: &str) -> String {
    match catch_unwind(AssertUnwindSafe(|| dispatch(operation, input))) {
        Ok(Ok(value)) => json!({ "ok": true, "value": value }).to_string(),
        Ok(Err(error)) => json!({ "ok": false, "error": error }).to_string(),
        Err(_) => json!({ "ok": false, "error": "Rust core panicked" }).to_string(),
    }
}

/// Calls the Rust core from Swift. The returned string must be released with
/// `atalk_core_string_free`.
///
/// # Safety
///
/// Both pointers must reference valid, NUL-terminated strings for the full
/// duration of the call.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atalk_core_call(
    operation: *const c_char,
    input: *const c_char,
) -> *mut c_char {
    let result = catch_unwind(AssertUnwindSafe(|| {
        if operation.is_null() || input.is_null() {
            return json!({ "ok": false, "error": "null bridge input" }).to_string();
        }
        // SAFETY: The Swift wrapper supplies valid, NUL-terminated strings for
        // the duration of this call and checks the returned UTF-8 payload.
        let operation = unsafe { CStr::from_ptr(operation) }.to_string_lossy();
        // SAFETY: Same contract as `operation` above.
        let input = unsafe { CStr::from_ptr(input) }.to_string_lossy();
        call_json(&operation, &input)
    }))
    .unwrap_or_else(|_| json!({ "ok": false, "error": "Rust FFI panicked" }).to_string());

    CString::new(result)
        .expect("JSON output cannot contain NUL")
        .into_raw()
}

/// Frees a string returned by `atalk_core_call`.
///
/// # Safety
///
/// `value` must be null or a pointer returned exactly once by
/// `atalk_core_call` that has not already been freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn atalk_core_string_free(value: *mut c_char) {
    if !value.is_null() {
        // SAFETY: Only pointers returned by `CString::into_raw` in
        // `atalk_core_call` are accepted by this function.
        drop(unsafe { CString::from_raw(value) });
    }
}

#[cfg(target_os = "android")]
mod android {
    use jni::{
        JNIEnv,
        objects::{JClass, JString},
        sys::jstring,
    };

    #[unsafe(no_mangle)]
    pub extern "system" fn Java_expo_modules_atalkcore_AtalkCoreBridge_call<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        operation: JString<'local>,
        input: JString<'local>,
    ) -> jstring {
        let result = (|| {
            let operation: String = env.get_string(&operation).ok()?.into();
            let input: String = env.get_string(&input).ok()?.into();
            Some(super::call_json(&operation, &input))
        })()
        .unwrap_or_else(|| {
            serde_json::json!({ "ok": false, "error": "invalid JNI string" }).to_string()
        });

        env.new_string(result)
            .map(JString::into_raw)
            .unwrap_or(std::ptr::null_mut())
    }
}

#[cfg(test)]
mod tests {
    use super::call_json;

    #[test]
    fn bridge_reports_version_and_errors_as_json() {
        let version: serde_json::Value =
            serde_json::from_str(&call_json("coreVersion", "{}")).unwrap();
        assert_eq!(version["ok"], true);
        assert_eq!(version["value"], "0.1.0");

        let error: serde_json::Value =
            serde_json::from_str(&call_json("notAnOperation", "{}")).unwrap();
        assert_eq!(error["ok"], false);
    }
}
