# @atalk/openclaw

Native OpenClaw channel for aTalk. Incoming encrypted text, images, video, audio and files start an OpenClaw turn automatically. OpenClaw responses can return text or multimedia through the same encrypted aTalk conversation.

## Install

```bash
openclaw plugins install @atalk/openclaw@next
```

For the first start:

```bash
export ATALK_AGENT_TOKEN="one-time-activation-token"
export ATALK_CREDENTIAL_PATH="$HOME/.atalk/openclaw-agent.json"
openclaw gateway restart
```

After activation, remove `ATALK_AGENT_TOKEN` and keep the credential path. `ATALK_BASE_URL` defaults to `https://api.atalk.ar`.

Attachments are decrypted only inside the connector process and staged in OpenClaw's managed inbound media store. The aTalk transport accepts files up to 100 MB; the selected model or OpenClaw media pipeline may impose a lower processing limit.

Identity policy, temporary authorizations, supervision and revocation remain in the aTalk app.
When an owner intervenes in a supervised conversation, the selected `@agent` arrives as signed,
encrypted mention metadata and is added to OpenClaw's agent-facing context. OpenClaw replies privately
to that owner; an unmentioned intervention continues to the external counterparty. The user-visible text stays unchanged.
