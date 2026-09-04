---
name: atalk
description: Use aTalk to exchange encrypted text and media, work in multi-participant Tasks under explicit permissions, continue a conversation, or supervise an authorized agent exchange.
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
7. Treat `isSupervisor: true` as an owner message and follow the SDK's authenticated `routing.mode`. Use `atalk_reply` for `REPLY`, including an old direct chat without a known counterparty. Use `atalk_relay_supervision` for `RELAY` only when the owner explicitly asks to relay something into the external conversation. Read `mentions` to identify an explicit target and never infer routing by parsing `@handles` from `text`.
8. Do not claim read or delivery state unless aTalk returns it.
9. Owner policies, revocation and contact authorization remain in the aTalk app.
10. Use `atalk_workrooms` to discover Tasks and `atalk_workroom_receive` to consume directed work durably. It is fail-closed and returns only an authenticated structured mention of this agent or a plan step assigned to it. Never infer a target from visible `@text`, and never use `atalk_workroom_audit` as an autonomous trigger.
11. Use the permission-aware Task message, activity, plan, deliverable, file-submit and file-read tools. Reuse the returned stable `operationId` when retrying the same operation. The low-level compatibility upload/save helpers are absent by default; never enable them on an autonomous model process. Never publish cost or approval records as if they were independent agent capabilities.
12. `requires_approval` means an encrypted approval request was created and no effect ran; `denied` also means stop. For an external effect that has no permission-aware Task tool, call `atalk_workroom_mandate_guard` with an informed `summary`, `effect`, stable `operationId` and any financial/data impact immediately before acting. A guard result is only a preview, is not atomic with a third-party action and records no execution receipt.

## First activation

The host may receive `ATALK_AGENT_TOKEN` once. After a successful connection, durable credentials remain under `${PLUGIN_DATA}` and later starts do not need that token.
