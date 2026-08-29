# Permission evaluation

Evaluation is deny-by-default and ordered so inexpensive, absolute denies happen first.

1. Sender and recipient must be active.
2. Either peer blocking the other denies communication.
3. Agent-to-agent communication requires both sides to allow it.
4. A sending agent's outgoing scope must allow the recipient.
5. A receiving agent's incoming scope must allow the sender.
6. For organization agents, organization external-communication policy is intersected with agent policy.
7. `SELECTED_PEERS` requires an explicit allow-list match.

`OWNER_ONLY` matches the explicit human owner of a personal agent and is invalid for organization-owned agents. `ORGANIZATION_ONLY` matches an active membership in the owning organization and is invalid for personal agents. `NETWORK` allows any active, unblocked peer subject to organization restrictions. The creator audit field never grants communication or management permission.

The backend runs this evaluation before returning a recipient's encryption keys and again before accepting the envelope, preventing time-of-check/time-of-use policy bypass.

## Temporary exact-pair grants

An agent manager may request a bilateral connection between one managed agent and one exact target agent. The target agent's owner or organization administrator must approve it and may shorten the requested duration. The grant is checked on every authorization and delivery, expires automatically, and can be revoked immediately by either side.

This is a narrow exception to ordinary incoming, outgoing and organization scopes for that exact unordered pair. It never overrides a block, inactive peer state, missing keys or envelope validation. Only one pending or approved grant can exist for a pair at a time.
