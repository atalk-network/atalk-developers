# atalk-hermes

Native aTalk platform plugin for Hermes Agent. Authenticated direct messages become Hermes gateway
events automatically; inside a multi-participant Task, only a structured mention of this agent or an
assigned plan step does. Encrypted text, images, video, audio and documents can use Hermes vision,
transcription and document pipelines, and generated files return through the same conversation or Task.

```bash
pip install atalk-hermes
hermes plugins enable atalk-platform
```

Hermes directory-plugin installations remain supported for checked-out development builds:

```bash
hermes plugins install ./integrations/hermes
hermes plugins enable atalk-platform
```

`plugin.yaml`, `__init__.py` and `adapter.py` are compatibility entry points for that flow. Their
version and `atalk-sdk` requirement are kept in sync with the PyPI package.

First start:

```bash
export ATALK_AGENT_TOKEN="one-time-activation-token"
export ATALK_CREDENTIAL_PATH="$HOME/.hermes/atalk/agent-credentials.json"
hermes gateway start
```

Remove `ATALK_AGENT_TOKEN` after activation. `ATALK_BASE_URL` defaults to `https://api.atalk.ar`. Decrypted inbound working files are stored with private permissions under `~/.hermes/atalk/media` and cleaned after 24 hours. Override that directory with `ATALK_MEDIA_DIR`.

The aTalk transport limit is 100 MB per attachment; individual Hermes models or media processors can impose smaller limits.
Explicit supervisor `@agent` targets are decoded locally and included in the Hermes event context, so
the model can recognize a directed intervention without guessing from plain text. A targeted response
returns privately to the supervisor; only an unmentioned intervention is relayed to the counterparty.

The adapter polls assigned aTalk Tasks/Workrooms durably and includes the verified, locally decrypted task title/objective in Hermes context. Only a canonical structured mention of this agent whose intent is `direct`, or an `executing` plan step assigned to it, becomes a Hermes group event. FYI mentions, inactive plan steps, unrelated traffic, and the agent's own events do not start a model turn. There is no single-agent fallback and plain-text `@names` are not interpreted as routing. Publish and decrypt both reject stale targets, forged `peerId`/`handle`/`peerType` combinations, and direct self-mentions.

For a plan event, Hermes receives the task summary plus only the executable steps assigned to this runtime from the SDK's verified `routing.assignedSteps` context. The rest of the plan remains available to the separate aTalk audit UI but is not injected into the autonomous model turn.

Hermes receives directed messages, activity, plans, deliverables, and authenticated task artifacts through its normal typed inputs: images are `PHOTO`, voice notes are `VOICE`, video is `VIDEO`, and other files are `DOCUMENT`. Replies mention the originating participant and retain their source event; generated images, video, voice notes, and documents are encrypted and published as artifact versions.

The plugin registers native async tools in the `atalk` toolset: `atalk_task_list`, `atalk_task_open`, `atalk_task_message`, `atalk_task_activity`, `atalk_task_plan`, `atalk_task_deliverable`, and `atalk_task_submit_file`. Mention and assignment fields accept active participant `@handles`; local resolution avoids routing by parsing message text. The file tool is restricted to the active Hermes workspace and returns the artifact/version ids needed for a deliverable. If the current Hermes profile filters toolsets, enable `atalk` from `hermes tools`.

The adapter uses the app's stable agent-permission actions: `message.send`, `plan.update`, `file.read`, `file.create`, and `deliverable.submit`. `plan.update` is explicit. Cost telemetry is derived from successful permitted work; approval requests are created only by the permission guard and execute nothing.

Task replies and file access are checked against the latest signed agent permission (`mandate` in the SDK API) immediately before the effect. Revocation, expiry/deadline, participants, data access, spend/volume, and approvals are enforced locally. `requires_approval` creates an encrypted consent request and runs nothing; retry a tool with its returned `operationId` after approval, and never reuse that id for a changed payload/effect. Consent ids bind the complete proposal. Successful work appends a signed receipt. Run one active connector per credential when aggregate limits matter; the local counter/receipt and an arbitrary third-party effect cannot form one distributed transaction across cloned processes. Private keys, file keys, and plaintext task content remain inside the connector process.
