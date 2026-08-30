# `@atalk/protocol`

Canonical TypeScript definitions for the aTalk wire protocol, encrypted envelopes, permission evaluation and WebSocket frames.

> Developer preview: protocol fields may evolve before `1.0.0`. Alpha releases are versioned together with `@atalk/sdk`.

```bash
npm install @atalk/protocol@next
```

The package exports:

- Zod schemas for client/server frames and encrypted envelopes;
- TypeScript types for peers, policies and messages;
- canonical JSON encoding and signature verification;
- TweetNaCl-based encryption helpers;
- authenticated attachment encryption, metadata envelopes and opaque chunking up to 100 MB;
- permission evaluation shared with the Rust golden vectors.

Applications normally install `@atalk/sdk` instead. Use this lower-level package when building another SDK, transport adapter or protocol conformance test.

Licensed under Apache-2.0.
