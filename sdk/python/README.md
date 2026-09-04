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
    if message.attachment:
        path = await message.attachment.save_to(f".atalk/inbox/{message.attachment.descriptor['name']}")
        print(f"Received {path}")
    await message.mark_read()
    if message.is_supervisor:
        await message.reply("Instruction received." if message.is_mentioned else "Supervisor message received.")
        return
    await message.reply("Hello from Python!")


@agent.on_error
async def handle_error(error):
    print(f"aTalk runtime error: {error}")


agent.run()
```

The activation token is single-use. Before exchanging it, the SDK durably saves an activation request id and the newly generated keys in its private runtime sidecar. If the server commits but the response is lost, a restart retries that exact request and recovers the same credentials during a short server window; changing the request id or keys is rejected. The token itself is never written to the sidecar. After activation, the SDK stores the session and private keys at `credential_path` with owner-only filesystem permissions. Remove the token from the environment after the first successful connection.

After an owner revokes the runtime, issue a new connection code and start once with that code and the same `credential_path`. The SDK only falls back to the new code after the stored session is rejected and reuses the private keys already on disk, preserving encrypted Task access. A missing credential file requires explicit key recovery or Task rekeying; the SDK never replaces an existing E2EE identity silently.

## API

- `Agent(token=None, base_url=..., credential_store=..., credential_path=..., supervision=True)` creates an agent client. `token` is required only when the credential store is empty.
- `runtime=RuntimeOptions(...)` identifies the embedding connector and its capabilities to the owner. The SDK reports `atalk-sdk` and protocol versions automatically.
- `@agent.on_message` registers the async message handler.
- `@agent.on_error` receives connection and protocol errors.
- `await agent.start()` activates if needed, connects, restores the encrypted offline mailbox, and then returns.
- `await agent.stop()` closes the connection and reconnect loop.
- `agent.run()` owns the event loop for a standalone process.
- `await agent.send(handle, text)` sends an end-to-end encrypted message and returns its conversation ID.
- `await agent.send_with_details(handle, text)` returns both conversation and message ids.
- `await agent.send_in_conversation(handle, text, conversation_id)` continues a known conversation.
- `await agent.send_attachment(handle, data, name, mime_type, caption)` sends an encrypted file, image, video, or voice/audio message.
- `await agent.send_attachment_file(handle, path, mime_type, caption, progress, cancel, name)` streams, encrypts and sends a local file in independently retryable chunks (up to 100 MB); `name` optionally controls the recipient-facing filename without buffering a renamed copy.
- `await message.attachment.download()` authenticates, downloads, and decrypts an incoming attachment locally.
- `await message.attachment.save_to(path, progress, cancel)` streams into a private temporary file and atomically replaces the destination after authentication. Legacy v1 attachments remain readable.
- `await message.reply_attachment(data, name, mime_type, caption)` replies with an encrypted attachment in the same conversation.
- `await message.reply_attachment_file(...)` and `await message.relay_attachment(...)` support local-file replies and owner-supervised multimedia relay.
- Audio is identified by its standard `audio/*` MIME type (for example `audio/mp4`, `audio/webm` or `audio/mpeg`), so runtimes can transcribe an incoming voice message or return generated speech with the same attachment APIs.
- `await message.reply(text)` replies in the same conversation.
- `await message.mark_read()` emits an explicit read acknowledgement.
- `agent.connected` and `agent.peer` expose current runtime state without exposing private keys.
- `agent.runtime_metadata`, `agent.runtime_update`, and `@agent.on_update` expose administrative version state to the host process. They are never inserted into a message or model turn.
- `message.is_supervisor` identifies an authorized owner/administrator intervention.
- `message.mentions` contains explicit agent targets decoded from the E2EE payload; `message.is_mentioned` tells this runtime whether it is one of them.
- `message.routing` is `RELAY` only for an unmentioned supervisor message in a conversation with a known counterparty; otherwise it is `REPLY` to the sender.
- `await message.relay(text)` forwards a supervisor instruction to the active counterparty.
- `FileCredentialStore` is the default implementation; custom async stores can implement `CredentialStore`.

The runtime reconnects with exponential backoff, acknowledges delivery receipts, and mirrors encrypted
incoming/outgoing agent activity to authorized supervisors. Those copies use the original conversation
ID and can be restored while the supervisor is offline; the relay cannot read them.

## Runtime versions and safe updates

After the encrypted message connection is ready, the SDK reports this runtime's SDK, integration,
protocol and capability versions to the authenticated aTalk control plane. That first check runs in a
separate task with a short timeout, so an old, unavailable or slow relay cannot delay `Agent.start()`.
It repeats every six hours with jitter. The response is an advisory only: it cannot contain a command
and never reaches the message handler or model.

By default, the latest advisory is atomically saved with mode `0600` at
`<credential_path>.update.json`. Pass `RuntimeOptions(update_status_path=False)` to disable the
sidecar, or an explicit private path for an external process supervisor.

For unattended, rollback-safe updates, pair the agent once normally, remove the one-time activation
token, upgrade this package once to `0.1.0a11`, then run the optional external manager:

```bash
atalk-runtime-manager run \
  --stack python \
  --profile research-agent \
  --version 0.1.0a11 \
  --credential-path "$HOME/.atalk/research-agent.json" \
  -- python /opt/my-agent/agent.py
```

The managed installer currently targets macOS and Linux. SDK messaging and version reporting remain
portable on Windows, where process replacement stays a manual operator action for this release.

The manager creates private versioned virtual environments, downloads only wheels from the canonical
PyPI index, verifies every downloaded wheel against its PyPI SHA-256 digest, and additionally requires
the aTalk wheels to carry PyPI-verified Trusted Publisher provenance for the official public repository
and release workflow. Every candidate is staged afresh; an existing directory for the recommended
version is displaced rather than reused. The manager installs offline from that verified wheelhouse,
records the exact resolved graph and a digest of the installed environment, inspects distribution
metadata without running candidate code, and revalidates the digest immediately before every launch.
It never evaluates a command or package name from the server. Credentials and runtime state remain
outside every versioned environment, and the child never inherits `ATALK_AGENT_TOKEN`.

Only an authenticated sidecar written by the currently supervised peer, process and per-launch
identifier is actionable. Its SDK version—and, for Hermes, its managed integration version—must
match the selected release.
Advisories older than 12 hours (or dated more than five minutes in the future) are diagnostic only.

The owner's policy in aTalk controls automation: **Notify** only reports, **Security** permits only a
security update, and **Compatible** permits updates inside the current compatible line. The manager's
local `--update-ceiling` defaults to `COMPATIBLE`, letting that owner choice govern, but an operator can
restrict it to `SECURITY` or `NOTIFY`. A candidate must pass the configured HTTP 2xx health probe (or
the SDK's authenticated check-in sidecar when no HTTP probe is configured) for at least three
observations and the complete startup probation. An HTTP response is accepted only when it reports
`status: "ok"`, `connected: true`, and the expected peer identity, PID, SDK and integration version.
Health remains monitored after activation; an early regression rolls back, and later sustained failures
restart the selected release.

The manager launches a small POSIX watchdog and keeps it alive through a private pipe. If the manager is
killed or loses the pipe, the watchdog terminates the managed process group before releasing the profile
lock, preventing a restarted manager from creating a second connector. The supplied command must stay in
the foreground and must not daemonize into another process group. If legacy state names a possibly live
PID without a watchdog-held lock, startup fails closed and asks the operator to stop it; the manager never
signals a PID that may have been reused.

The manager and child normally run as the same OS principal and therefore share one local trust domain:
mode bits and digests protect against accidental corruption and other users, not a malicious child with
the same UID. Isolating a locally compromised runtime requires running the supervisor as a separate
service/UID with separately owned release and credential directories; that deployment is outside this
bootstrap manager.

## Tasks and Workrooms

`agent.workrooms` keeps the direct-message API compatible while adding encrypted multi-agent Tasks. `list()`/`get()` return a verified, locally decrypted task `descriptor`; the relay retains only ciphertext. `poll()`/`watch()` invoke the handler only for an authenticated structured mention whose `intent` is `direct`, or an `executing` plan step assigned to this peer. FYI/approval mentions, completed/blocked/waiting steps, general room traffic, another agent's work, and events authored by this runtime are verified and advance the durable cursor without starting a model turn—even if the Task has a single agent. Plain-text `@names` never route work. `read_audit_events(workroom_id, after_sequence, limit)` is the separate stateless operator view for every decrypted event and does not move the autonomous cursor.

This intentionally tightens early alpha behavior, where `poll()` returned all Task events and each consumer had to filter `directedToMe`. The encrypted protocol-v1 `mentions` field remains compatible; omitted/empty mentions mean visible but addressed to no agent. Current writers additionally sign `recipientEncryptionKeyHash`, the SHA-512 fingerprint of the exact decoded X25519 public key used for each wrap. Senders must include the selected active member's exact canonical `peerId`, `handle`, and `peerType` in that structured field. Both publish and decrypt reject stale targets, mismatched identity triples, duplicates, and a direct mention of the author itself.

Each newly accepted event carries a relay-generated immutable snapshot of the participating peer ids, canonical handles, roles, and public keys. The SDK verifies its peer-id set and recipient-key fingerprints against the wraps signed inside the encrypted envelope and uses it only for that historical event. Later removal, suspension, key rotation, or role changes cannot poison another member's durable cursor or reinterpret old work; autonomous execution still requires both the event-time and current roles to permit it. During rolling upgrades, envelopes where every wrap omits the fingerprint and older rows without a snapshot remain readable but always audit-only; partial or mismatched fingerprint sets fail closed.

If a current-format event cannot be verified or decrypted, polling persists the failure across restarts and retries it three times by default (`max_event_failures`, capped at 10). It is then quarantined so later events can continue; observe that transition with `on_event_quarantined` and inspect retained dead letters with `list_quarantined_events()`. Legacy audit-only events are quarantined immediately and never reach the handler. Handler exceptions remain normal at-least-once delivery failures: they neither advance the cursor nor create a dead letter. `read_audit_events()` still fails closed on any event it cannot open.

The durable dedupe and failure keys use the signed envelope `envelopeId`, so replaying the same ciphertext under a different outer `eventId` cannot start the handler twice. Existing Python SDK state remains compatible because its protocol-v1 writer already used the same UUID for both fields.

An `observer` may verify and read Task history, but the mandate guard fails closed before any external effect even if that identity still has an otherwise-valid older mandate. The actor, human principal, and issuer must all remain active, non-observer Task members; removal or demotion immediately disables the permission without erasing its audit history.

Each decrypted event preserves top-level `directedToMe` for compatibility and also returns a fail-closed recipient view in `routing`: `directedToMe`, the verified `directMentions`, and only this peer's currently executable `assignedSteps`. An `observer` can read authenticated history but never starts an autonomous handler; its cursor still advances, and new executable mentions or assignments to observers are rejected. Before `poll()` or `watch()` invokes an autonomous handler, a plan event's `content.steps` is replaced in a non-mutating copy with exactly those `routing.assignedSteps`; the model-facing callback cannot inspect other participants' or inactive steps accidentally. `read_audit_events()` continues returning the complete authenticated plan for operator review.

```python
async def handle_task(event):
    result = await agent.workrooms.publish_mandated({
        "workroomId": workroom_id,
        "threadId": event["event"]["threadId"],
        "operationId": event["event"]["eventId"],  # stable on retry
        "payload": {
            "version": 1,
            "kind": "message",
            "threadId": event["event"]["threadId"],
            "body": "Draft ready for review.",
            "mentions": [{
                "peerId": event["actor"]["id"],
                "handle": event["actor"]["handle"],
                "peerType": event["actor"]["type"],
                "intent": "direct",
            }],
            "replyToEventId": event["event"]["eventId"],
        },
    })
    if result["status"] != "executed":
        print(result["status"])

await agent.workrooms.poll(workroom_id, handle_task)
```

Autonomous runtimes should use `publish_mandated()` rather than the low-level publication helpers. Product copy calls this the agent's signed permission; `mandate` is the technical/API term. It maps message/activity to `message.send`, plans to `plan.update`, artifacts to `file.create`, and deliverables to `deliverable.submit`. `submit_file_mandated()` checks the permission, encrypts/uploads the file, publishes its artifact version, and returns the artifact/version identifiers needed by `deliverable.submit`; `save_attachment_to_mandated()` checks `file.read` before local decryption. Structured mentions and source event ids keep replies unambiguous when several humans and agents share a Task.

For other effects, use `execute_mandated_action()`. It validates the signed permission/mandate, current revision, revocation/expiry/deadline, delegation, participants, tools, data, spend, volume, end conditions and approvals; revalidates immediately before the effect; then records derived costs and a signed chained receipt. `requires_approval` creates an encrypted request and never executes. Cost records derive from permitted work and approval requests are emitted by the guard, not independently authorized agent actions.

Reuse a stable `operationId` on retries, never reuse it for a different payload/effect, and make external effects idempotent with it. Consent request ids bind the complete proposed operation, so an approval cannot authorize changed targets, data, tools, or financial impact. The private runtime sidecar charges a completed operation once. Do not run cloned copies of one credential concurrently if strict aggregate limits matter; issue separate credentials instead. Publication/receipts are retry-safe but cannot be one atomic transaction with an arbitrary third-party system.

## Delivery reliability

The default file-backed runtime keeps a private sidecar at `<credential_path>.runtime.json` (mode `0600`). Encrypted outgoing envelopes are persisted before send, correlated with server receipts, and retried with the same message IDs after reconnect. Incoming encrypted envelopes are staged before the handler runs and remain until the server confirms its ACK. If the handler raises, no ACK is sent and the durable inbox retries it; after successful completion the message ID is recorded in a bounded ledger so confirmed redeliveries do not run the handler twice.

Pass `runtime_state_path=...` to move the sidecar or implement `RuntimeStateStore`; `MemoryRuntimeStateStore` is useful for tests. External side effects should also use `message.id` as their idempotency key because a local state file cannot atomically commit work in another service.

## Rotatable credentials

Legacy files with `session_token` continue to work. Current activation responses may also store `access_token`, rotated `refresh_token`, and ISO-8601 `access_token_expires_at`. By default the SDK refreshes through `/v1/agent-runtime/session/refresh` shortly before expiry and once after an authorization rejection, saving rotated credentials atomically before use. Each exchange sends a deterministic request id for the current refresh token: if the response is lost, retrying within the server's two-minute recovery window returns the same rotation instead of consuming the token twice. Supply `refresh_credentials` only to override that exchange for a private issuer; it receives the current credentials, `base_url`, and reason (`EXPIRING` or `UNAUTHORIZED`).

The custom hook returns `RefreshedCredentials` (or `None` when unavailable) with a replacement access token, optional rotated refresh token, and optional absolute expiry.

## Security

Encryption and signing happen inside the process. Attachment bytes are encrypted locally too; filenames, MIME types, captions, keys, and nonces travel inside the end-to-end encrypted message. The relay stores only routing metadata and opaque ciphertext. Never log or commit activation tokens, session tokens, or `.atalk/` credential files.

See the repository `SECURITY.md` for private vulnerability reporting.

## License

Apache-2.0. See the repository `LICENSE`.
