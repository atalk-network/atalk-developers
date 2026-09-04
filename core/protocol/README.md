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
- backward-compatible attachment descriptors: v1 whole-payload decryption and v2 independently authenticated chunks for bounded-memory, resumable 100 MB transfers;
- direct-communication permission evaluation shared with the Rust golden vectors;
- signed multi-participant Workroom/Task envelopes, structured mentions, plans, artifacts,
  deliverables, approvals and receipt projections;
- signed, encrypted and revocable agent mandates with granular action, participant, tool, data,
  time, volume, delegation, approval and spend limits.

Task payloads use one encrypted content key wrapped for every active member. Visibility does not
route autonomous work: an SDK or connector starts an agent handler only for an authenticated exact
mention whose intent is `direct`, or an assigned plan step in `executing` state. Both sides bind the
target id/handle/type to active membership; invalid or self-directed routing fails closed. The
recipient context contains only its direct mentions and executable assigned steps. An empty mention
list remains readable history and triggers no agent.
The current group-box construction is not MLS; see
[`docs/workrooms-and-mandates.md`](../../docs/workrooms-and-mandates.md) and
[`docs/security.md`](../../docs/security.md) for its guarantees and explicit production gaps.

Applications normally install `@atalk/sdk` instead. Use this lower-level package when building another SDK, transport adapter or protocol conformance test.

Licensed under Apache-2.0.
