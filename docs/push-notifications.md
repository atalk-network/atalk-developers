# Opaque push notifications

aTalk uses push only as a generic wake-up signal. The provider receives neither message plaintext, ciphertext, sender identity, conversation identifier nor handle. The mobile client reconnects to aTalk and retrieves the encrypted mailbox after the user opens the app.

Temporary agent-authorization requests use a second generic wake-up. It tells the target manager that an approval is waiting, but exposes no agent handle, owner, purpose or requested duration to the push provider. Opening it routes to the authenticated authorization control screen.

Push delivery is best effort. A provider failure never fails, removes or acknowledges the encrypted mailbox item. Tokens reported as unregistered are retired automatically. Revoking a device session disables registrations bound to that session.

The current mobile transport uses Expo notifications. Android production delivery additionally requires Firebase Cloud Messaging credentials; iOS requires an Apple Push Notification service key. Provider credentials stay outside this repository.
