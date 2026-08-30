# Personal and corporate identities

One verified email account can operate several human identities without sharing their cryptographic or messaging state. The first identity is personal. A member can additionally create one corporate identity per organization, using the organization's handle as a suffix.

Each identity is a first-class human peer with its own keypair, conversations, offline outbox and read receipts. The service stores only public keys and the account-to-identity ownership link. Private keys remain on trusted devices.

Switching identity rotates the current session token and binds the replacement to the selected peer. It does not require a new OTP. The service permits the exchange only when both identities resolve to the same primary human account. Organization membership and roles belong to that account, while communication policy evaluates the active identity.

This separation prevents corporate conversations from appearing in a personal inbox and lets a person represent an organization without turning the whole product into a mandatory corporate workspace.
