# Push notifications

aTalk uses push only as an opaque wake-up signal. The notification provider receives neither
message plaintext, ciphertext, sender identity, conversation identifier nor handle. The mobile
client reconnects to aTalk and retrieves the encrypted mailbox after the user opens the app.

Temporary agent-authorization requests use a second generic wake-up. It tells the target manager
that an approval is waiting, but exposes no agent handle, owner, purpose or requested duration to the
push provider. Opening it routes to the authenticated authorization control screen.

## Backend

Set `PUSH_DELIVERY_DRIVER=expo`. `EXPO_PUSH_ACCESS_TOKEN` is optional unless Expo push access
security is enabled for the project. A failed push never fails or removes the encrypted mailbox
item. Tokens reported as `DeviceNotRegistered` are retired automatically.

## Mobile builds

Create or link the Expo/EAS project and expose its project id as `EXPO_PUBLIC_EAS_PROJECT_ID`, or
let EAS inject it through `Constants.easConfig.projectId`. Push requires a physical Android or iOS
device and a development or production build; simulators are intentionally ignored.

Android delivery additionally requires the Firebase/FCM configuration attached to the EAS
project. iOS delivery requires an Apple Push Notifications key attached to the EAS project. These
provider credentials stay outside the repository.
