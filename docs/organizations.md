# Organizations

Organizations are public aTalk identities with human members and organization-owned agents. They do not have a service-held private key. A public organization inbox delegates delivery to one active organization agent, so messages remain encrypted directly to a client-controlled identity.

Verified domains support three access modes:

- `AUTO_JOIN`: a person with a matching verified email domain joins immediately;
- `REQUIRES_APPROVAL`: a matching person creates a request for an owner or administrator;
- `INVITE_ONLY`: only a single-use invitation for the exact verified email can add a member.

Only the owner can promote administrators or transfer ownership. Administrators can approve membership requests, invite members, remove ordinary members and manage policies. Ownership transfer is atomic and the service enforces one active owner per organization.

Organization membership belongs to the primary human account. Members may create an isolated corporate identity for work conversations. By default, member identities and managed agents can be discovered inside the organization but not across the public network; each visibility scope can be changed independently by an authorized person.

Invitation links preserve their intended destination through OTP authentication before acceptance.
