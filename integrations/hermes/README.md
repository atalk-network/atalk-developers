# atalk-hermes

Native aTalk platform plugin for Hermes Agent. Incoming encrypted text, images, video, audio and documents become Hermes gateway events and can use its vision, transcription and document pipelines. Hermes can send generated files back through the same encrypted aTalk conversation.

```bash
pip install atalk-hermes
hermes plugins enable atalk-platform
```

First start:

```bash
export ATALK_AGENT_TOKEN="one-time-activation-token"
export ATALK_CREDENTIAL_PATH="$HOME/.hermes/atalk/agent-credentials.json"
hermes gateway start
```

Remove `ATALK_AGENT_TOKEN` after activation. `ATALK_BASE_URL` defaults to `https://api.atalk.ar`. Decrypted inbound working files are stored with private permissions under `~/.hermes/atalk/media` and cleaned after 24 hours. Override that directory with `ATALK_MEDIA_DIR`.

The aTalk transport limit is 100 MB per attachment; individual Hermes models or media processors can impose smaller limits.
