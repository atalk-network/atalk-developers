# ADR 0001: TypeScript vertical slice followed by the Rust portable core

Status: superseded after the first vertical slice.

The product brief prefers Rust but explicitly permits another implementation when Rust materially blocks MVP velocity, provided one protocol is preserved. The first slice therefore implements canonical schemas, crypto and permission logic in a shared TypeScript package used by Expo, backend and Node SDK. Python follows the same normative document and golden vectors.

The protocol behavior is now validated and `core/rust` implements the portable Rust core. The backend and Node SDK use it through the `@atalk/core-native` N-API addon. Expo uses it through a local module backed by a C ABI on iOS and JNI on Android. TypeScript remains responsible for wire schemas and the web-only development fallback. Python keeps an independent implementation. Rust, TypeScript, Node and Python all pass the same golden vector without changing the wire format.
