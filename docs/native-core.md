# Native Rust core

## Runtime mapping

`core/rust` is the source of truth for key generation, message cryptography, signature verification and permission decisions.

| Consumer | Binding | Artifact |
| --- | --- | --- |
| Backend and Node SDK | N-API through NAPI-RS | `core/node-native/atalk-core-native.<target>.node` |
| Expo on iOS | Swift calling the C ABI | `AtalkCoreRust.xcframework` |
| Expo on Android | Kotlin calling JNI | `libatalk_core_mobile.so` per ABI |
| Expo on web | TypeScript compatibility adapter | JavaScript bundle |
| Python SDK | Independent PyNaCl-compatible implementation | Python wheel |

All native bindings expose `coreVersion`, `generateIdentityKeys`, `encryptText`, `decryptText`, `verifyEnvelope` and `evaluatePermission`. The shared bridge accepts JSON and returns structured JSON so adding fields does not require changing exported C symbols or JNI method signatures.

## Local build

Build the addon for the current Node platform:

```bash
pnpm build:native:node
pnpm --filter @atalk/core-native test
```

Build the iOS XCFramework and four Android ABI libraries:

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
pnpm build:native:mobile
pnpm --filter @atalk/mobile prebuild
```

The mobile script currently targets:

- iOS device `arm64` and Apple Silicon simulator `arm64`;
- Android `arm64-v8a`, `armeabi-v7a`, `x86` and `x86_64` with API 26 linkers.

The application is pinned to Expo SDK 52 / React Native 0.76.9. The verified local toolchain is Xcode 16.2, Android compile SDK 35 and NDK 26.1.10909125. Keep generated native projects aligned with that Expo SDK; mixing a newer prebuild template with Expo 52 breaks Gradle plugin resolution.

## Verification

```bash
cargo fmt --all --check
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pnpm typecheck
pnpm test
pnpm --filter @atalk/mobile lint
```

The Rust vector test reproduces the canonical TypeScript envelope byte-for-byte. The N-API test repeats that assertion through Node. Android validation assembles the complete `:app:assembleDebug` target and runs it on an emulator/device; the welcome screen displays the value returned by the native `coreVersion` call.

## Distribution

Generated `.node`, `.so` and `.xcframework` files are ignored to avoid committing large platform binaries. A release pipeline must build them in a trusted environment before packaging:

- publish one N-API binary per supported Node target and keep the JavaScript loader beside it;
- build Android libraries before Gradle packages the AAB/APK;
- build the XCFramework before CocoaPods resolves the local Expo module;
- sign release applications with production credentials; the generated Android project currently uses a debug keystore only.

The bridge version follows the Rust crate version. Any incompatible input/output change requires a protocol version decision and new cross-runtime golden vectors before release.
