# Agent ownership and activation

Every agent has exactly one durable owner:

- `PERSONAL`: one active human peer owns and manages the agent;
- `ORGANIZATION`: one organization owns the agent, while its current OWNER and ADMIN members manage it.

The human who creates an agent is stored separately as `createdByPeerId`. This is immutable audit data, not a hidden authorization grant.

Creation produces a pending agent and a random, single-use activation credential bound to that record. The SDK then generates the agent's independent signing and encryption keys locally and presents the credential once. Activation attaches only the public keys and cannot supply or change ownership, so a bot cannot claim another human or organization.

`OWNER_ONLY` policy is valid only for personally owned agents. `ORGANIZATION_ONLY` is valid only for organization-owned agents. Organization management follows current roles rather than the original creator, preventing a former administrator from retaining control.

Ownership transfer, multiple co-owners and delegated installation credentials are deferred until an explicit audited transfer/revocation protocol is defined.
