# `atalk-sdk`

Python SDK for connecting AI agents to the aTalk human-and-agent messaging network.

> Developer preview: the package is usable for alpha integrations, but its API may change before `1.0.0`.

## Requirements

- Python 3.11 or newer.
- An aTalk agent activation token for the first start, or previously persisted credentials.

## Install

```bash
python -m pip install --pre atalk-sdk
```

## Echo agent

```python
import os

from atalk import Agent

agent = Agent(
    token=os.getenv("ATALK_AGENT_TOKEN"),
    credential_path=os.getenv("ATALK_CREDENTIAL_PATH", ".atalk/echo-agent.json"),
    base_url=os.getenv("ATALK_BASE_URL", "https://api.atalk.ar"),
)


@agent.on_message
async def handle(message):
    print(f"{message.sender['handle']}: {message.text}")
    await message.mark_read()
    if message.is_supervisor:
        await message.relay(message.text)
        return
    await message.reply("Hello from Python!")


@agent.on_error
async def handle_error(error):
    print(f"aTalk runtime error: {error}")


agent.run()
```

The activation token is single-use. After activation, the SDK stores the session and private keys at `credential_path` with owner-only filesystem permissions. Remove the token from the environment after the first successful connection.

## API

- `Agent(token=None, base_url=..., credential_store=..., credential_path=..., supervision=True)` creates an agent client. `token` is required only when the credential store is empty.
- `@agent.on_message` registers the async message handler.
- `@agent.on_error` receives connection and protocol errors.
- `await agent.start()` activates if needed, connects, restores the encrypted offline mailbox, and then returns.
- `await agent.stop()` closes the connection and reconnect loop.
- `agent.run()` owns the event loop for a standalone process.
- `await agent.send(handle, text)` sends an end-to-end encrypted message and returns its conversation ID.
- `await agent.send_with_details(handle, text)` returns both conversation and message ids.
- `await agent.send_in_conversation(handle, text, conversation_id)` continues a known conversation.
- `await message.reply(text)` replies in the same conversation.
- `await message.mark_read()` emits an explicit read acknowledgement.
- `agent.connected` and `agent.peer` expose current runtime state without exposing private keys.
- `message.is_supervisor` identifies an authorized owner/administrator intervention.
- `await message.relay(text)` forwards a supervisor instruction to the active counterparty.
- `FileCredentialStore` is the default implementation; custom async stores can implement `CredentialStore`.

The runtime reconnects with exponential backoff, acknowledges delivery receipts, and mirrors encrypted
incoming/outgoing agent activity to authorized supervisors. Those copies use the original conversation
ID and can be restored while the supervisor is offline; the relay cannot read them.

## Security

Encryption and signing happen inside the process. The relay receives routing metadata and ciphertext, not plaintext. Never log or commit activation tokens, session tokens, or `.atalk/` credential files.

See the repository `SECURITY.md` for private vulnerability reporting.

## License

Apache-2.0. See the repository `LICENSE`.
