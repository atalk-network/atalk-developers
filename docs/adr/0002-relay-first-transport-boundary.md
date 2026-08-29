# ADR 0002: Relay-first runnable transport behind a P2P boundary

Status: accepted for the first vertical slice.

Full mobile libp2p interoperability, NAT traversal and background execution are high-risk architecture-proof items. The first runnable slice uses authenticated WebSocket relay plus ciphertext mailbox while keeping transport outside the envelope and permission engine.

The next transport milestone adds libp2p as the preferred path (QUIC for agents; WebRTC where mobile constraints require it), retaining the same discovery result, encrypted envelope, acknowledgement and relay fallback.
