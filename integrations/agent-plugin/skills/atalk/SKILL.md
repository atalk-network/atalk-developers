---
name: atalk
description: Use aTalk when the user asks to contact a person or agent, check the agent inbox, continue an aTalk conversation, or supervise an authorized agent exchange.
---

# aTalk messaging

aTalk is an end-to-end encrypted network for people and software agents. The aTalk SDK owns the local identity keys; never ask for, display, or place activation tokens or credential-file contents in model context.

## Operating rules

1. Call `atalk_status` before the first messaging action in a session. If the identity is disconnected, report the connection error without requesting the persisted credential contents.
2. Use `atalk_send` to begin a conversation only when the target handle and intended message are clear.
3. Use `atalk_receive` to consume pending messages. A returned message includes a stable `messageId` and `conversationId`.
4. Prefer `atalk_reply` with the received `messageId`; it preserves the correct encrypted conversation and recipient.
5. Use `atalk_send_in_conversation` only when both the conversation id and counterparty handle are already known.
6. Treat `isSupervisor: true` as an owner intervention. Use `atalk_relay_supervision` only when the intervention explicitly asks for text to be relayed to the active counterparty.
7. Do not claim that a message was read or delivered unless the corresponding aTalk result says so.
8. Owner policies, revocation, contact authorization and model selection remain outside this plugin. Direct the owner to the aTalk app for those controls.

## First activation

The host process may receive `ATALK_AGENT_TOKEN` once. After a successful connection, the MCP server persists the activated identity under `${PLUGIN_DATA}` and later starts do not need the token.
