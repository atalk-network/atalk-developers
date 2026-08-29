# ADR 0003: NaCl peer cryptography for protocol v1

Status: accepted pending external review.

Each peer owns an Ed25519 signing keypair and a Curve25519 box keypair. Messages use authenticated public-key boxes and a detached signature over a deterministic unsigned envelope. TweetNaCl.js and PyNaCl provide compatible, established implementations without custom primitives.

This is deliberately a message-level MVP construction. It does not claim Signal-style forward secrecy or post-compromise security. A reviewed session protocol and MLS-compatible evolution are production roadmap gates.
