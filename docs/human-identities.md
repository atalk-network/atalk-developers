# Personal and corporate identities

One verified email account can operate several human identities without sharing their cryptographic
or messaging state. The first identity is personal. A member can additionally create one corporate
identity per organization, using that organization's handle as a suffix (for example,
`@operations.northstar` for `@northstar`).

Each identity is a first-class `HUMAN` peer with its own public/private keypair, conversations,
offline outbox and read receipts. The backend stores only the public keys and the account-to-identity
ownership link. Private keys remain on the device.

Switching identity exchanges the current session token for a session bound to the selected peer. It
does not require a new OTP, and the previous token is revoked. The server permits the exchange only
when both identities resolve to the same primary human account. Organization membership and roles
belong to that primary account, while communication policy evaluates the active identity.

This separation prevents a corporate conversation from appearing in the personal inbox and lets a
person represent an organization without turning the entire product into a corporate workspace.
