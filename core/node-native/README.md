# `@atalk/core-native`

Prebuilt N-API bindings for the aTalk Rust protocol, cryptography and authorization core.

This is an internal runtime dependency of `@atalk/sdk`; application developers should install the SDK rather than this package directly.

The root npm package uses optional platform packages so the package manager downloads only the binary matching the consumer's OS, CPU and Linux libc. No compiler or post-install network download is required.

Supported alpha targets:

- macOS arm64 and x64;
- Linux arm64 and x64 with glibc;
- Linux arm64 and x64 with musl;
- Windows arm64 and x64 with MSVC.

Every release must build and test the configured target matrix before any immutable npm package is published.

Licensed under Apache-2.0.
