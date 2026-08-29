# Agent ownership and activation

## Model

Every agent has exactly one durable owner:

- `PERSONAL`: one active human peer owns and manages the agent;
- `ORGANIZATION`: one organization owns the agent, while its current OWNER and ADMIN members manage it.

The human who creates an agent is stored separately as `createdByPeerId`. This is immutable audit data. It does not grant control, survive a role change as a hidden permission or substitute for ownership.

## Creation and activation flow

1. An authenticated human requests an agent record.
2. For personal ownership, the backend assigns that human as owner. For organization ownership, it verifies a current OWNER or ADMIN role.
3. The backend creates a pending agent and a random, single-use activation credential bound to that record.
4. The SDK generates signing and encryption keys locally and presents the credential once.
5. The backend attaches only the public keys, activates the existing record and consumes the credential.

The activating process never supplies an owner or organization, so a bot cannot claim another human or tenant by changing its activation request.

## API shape

Create a personal agent:

```json
{
  "owner": { "kind": "PERSONAL" },
  "handle": "@ariel.assistant",
  "displayName": "Ariel Assistant"
}
```

Create an organization agent:

```json
{
  "owner": {
    "kind": "ORGANIZATION",
    "organizationId": "00000000-0000-4000-8000-000000000001"
  },
  "handle": "@sales.acme",
  "displayName": "Sales"
}
```

The response returns the normalized `owner`, `createdByPeerId`, pending peer and activation token. List and management responses retain the same distinction.

## Authorization invariants

- Only a human can create an agent.
- A personal agent is always owned by its authenticated creator in the MVP.
- Only a current organization OWNER or ADMIN can create or change policy for an organization agent.
- Organization members may discover the organization's agents but do not gain management rights.
- `OWNER_ONLY` is valid only for personal agents.
- `ORGANIZATION_ONLY` is valid only for organization agents.
- A creator has no special access after losing the organization role that granted creation.

Ownership transfer, multiple co-owners and delegated installation credentials are intentionally deferred. They require an explicit audited transfer/revocation protocol rather than changing owner identifiers in place.
