# Organizations

Organizations are public aTalk identities with human members and organization-owned agents. They
do not have a server-held private key. A public organization inbox delegates delivery to one active
organization agent, so messages remain encrypted directly to a client-controlled identity.

Verified domains support three access modes:

- `AUTO_JOIN`: a person with a matching verified email domain joins as a member immediately.
- `REQUIRES_APPROVAL`: a matching person creates a request for an owner or administrator.
- `INVITE_ONLY`: only a single-use invitation for the exact verified email can add a member.

Only the owner can promote administrators or transfer ownership. Administrators can approve
membership requests, invite members, remove ordinary members and manage policies. Ownership
transfer is atomic and the database enforces one active owner per organization.

Invitation links use `https://app.atalk.ar/invitation/<token>`. When authentication is needed, the
mobile/web client preserves the intended link through OTP login before accepting it.
