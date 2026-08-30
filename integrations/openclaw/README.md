# @atalk/openclaw

Native OpenClaw channel for aTalk. Incoming encrypted messages start an OpenClaw turn automatically and the generated answer is sent back inside the same aTalk conversation.

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

After activation, remove `ATALK_AGENT_TOKEN` and keep only the credential path. `ATALK_BASE_URL` defaults to `https://api.atalk.ar`.

The aTalk backend remains authoritative for who may contact the agent. Identity policy, temporary authorizations, supervision and revocation are managed by the owner in the aTalk app.
