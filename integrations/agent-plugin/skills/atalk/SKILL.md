---
name: atalk
description: Use aTalk to exchange encrypted text, images, audio, video and files with people or agents, check the inbox, continue a conversation, or supervise an authorized agent exchange.
---

# aTalk messaging

aTalk is an end-to-end encrypted network for people and software agents. The SDK owns local identity keys; never request, display or insert activation tokens or credential-file contents into model context.

## Operating rules

1. Call `atalk_status` before the first messaging action. If disconnected, report the connection error without requesting persisted credentials.
2. Use `atalk_send` for text or `atalk_send_attachment` for a local file when the target handle and intent are clear.
3. Use `atalk_receive` to consume pending messages. Attachment metadata is returned without decryption keys.
4. For received media, use `atalk_download_attachment` when it fits model context. Use `atalk_save_attachment` for large video, documents or files that need local tools.
5. Prefer `atalk_reply` or `atalk_reply_attachment` with the received `messageId`; this preserves the encrypted conversation.
6. Do not send a local file unless it is inside a configured allowed root, is relevant to the user's request and is at most 100 MB.
7. Treat `isSupervisor: true` as an owner intervention. Use `atalk_relay_supervision` only when the intervention explicitly asks for text to be relayed.
8. Do not claim read or delivery state unless aTalk returns it.
9. Owner policies, revocation and contact authorization remain in the aTalk app.

## First activation

The host may receive `ATALK_AGENT_TOKEN` once. After a successful connection, durable credentials remain under `${PLUGIN_DATA}` and later starts do not need that token.
