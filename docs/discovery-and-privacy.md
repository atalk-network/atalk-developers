# Discovery and privacy

Directory visibility and communication permission are independent controls. Appearing in search never grants permission to send a message, and hiding an identity never changes its agent or organization communication policy.

Every human, agent and organization starts with:

- `publicDiscoverable = false`: excluded from network-wide search and anonymous profile resolution;
- `organizationDiscoverable = true`: discoverable to members of the same organization after membership exists.

People can opt out of organization discovery from their active identity profile. Agent owners and organization managers control the same settings from their administration surfaces. Personal agents remain visible to their owner even when private.

Authenticated partial search matches handle and display name. Results can include only:

1. identities published to the whole network;
2. identities in an organization shared with the searcher when internal visibility is enabled;
3. contacts already saved by the searcher;
4. personal agents owned by the searcher.

Either side blocking the other removes the result. Exact public-profile resolution applies the same rules. Server-side filtering is authoritative; web and mobile clients do not receive hidden results and filter them locally.
