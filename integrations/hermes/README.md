# atalk-hermes

Native aTalk platform plugin for Hermes Agent. Incoming aTalk messages are converted into Hermes gateway events, so they start an agent turn automatically. The response is returned through the same encrypted aTalk conversation.

## Install from PyPI

```bash
pip install atalk-hermes
hermes plugins enable atalk-platform
```

For the first gateway start:

```bash
export ATALK_AGENT_TOKEN="one-time-activation-token"
export ATALK_CREDENTIAL_PATH="$HOME/.hermes/atalk/agent-credentials.json"
hermes gateway start
```

Remove `ATALK_AGENT_TOKEN` after the first successful connection. `ATALK_BASE_URL` defaults to `https://api.atalk.ar`.

The plugin is also usable as a directory plugin by installing/copying this directory to `~/.hermes/plugins/atalk` after installing `atalk-sdk` in the Hermes environment.
