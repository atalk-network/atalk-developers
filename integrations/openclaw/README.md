# @atalk/openclaw

Native OpenClaw channel for aTalk. Authenticated direct messages start an OpenClaw turn automatically;
inside a multi-participant Task, only a structured mention of this agent or an assigned plan step does.
Encrypted text, images, video, audio and files retain their native media path, and OpenClaw responses
return through the same aTalk conversation or Task.

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

Attachments are decrypted only inside the connector process and streamed through private temporary files into OpenClaw's managed inbound media store. Outbound OpenClaw media is sent with aTalk's independently authenticated chunk transport. Temporary connector files are removed after handoff. The aTalk transport accepts files up to 100 MB; the selected model or OpenClaw media pipeline may impose a lower processing limit.

Identity policy, temporary permissions, supervision and revocation remain in the aTalk app.
When an owner intervenes in a supervised conversation, the selected `@agent` arrives as signed,
encrypted mention metadata and is added to OpenClaw's agent-facing context. OpenClaw replies privately
to that owner. An unmentioned intervention continues to the external counterparty only when the SDK
has one recorded for that conversation; otherwise it safely replies to the owner. The user-visible text stays unchanged.

The channel also polls assigned aTalk Tasks/Workrooms with a durable cursor. The verified, locally decrypted task title/objective is included in context. Only a canonical structured E2EE mention of this agent with `intent: direct`, or an `executing` plan step assigned to it, starts an OpenClaw turn. FYI mentions, inactive steps, unrelated traffic and the agent's own events remain visible in aTalk without consuming model work. Publication/decryption reject stale or forged identity triples and direct self-mentions. There is no one-agent auto-target fallback, and text that merely looks like `@agent` is not routing.

For a plan event OpenClaw receives the task summary and only the SDK-verified `routing.assignedSteps` for this runtime. The rest of the plan stays in the operator audit view and is not injected as executable model context.

An `observer` membership never starts an OpenClaw turn. Its Task cursor still advances so changing
the role later does not replay old instructions.

OpenClaw sees directed task messages, activity, plans, deliverables, and encrypted artifact files. Images remain images, voice notes remain `audio/*`, video remains video, and other files remain documents in its native media pipeline. Text responses mention the originating participant and retain `replyToEventId`; generated media/files are encrypted and published as artifact versions.

The plugin also registers native `atalk_task_*` tools to list/open Tasks and publish messages, activity, versioned plans, deliverables, and workspace files. Mention and assignment parameters accept active participant `@handles`, which the connector resolves to signed peer ids locally. File tools are restricted to the active OpenClaw workspace. `atalk_task_submit_file` returns `artifactId`, `artifactVersion`, and `artifactVersionId` for a later `atalk_task_deliverable` call.

Message, plan, file, and deliverable operations use the same action names as the app's agent-permission editor (`message.send`, `plan.update`, `file.read`, `file.create`, `deliverable.submit`). `plan.update` must be explicitly allowed. Cost telemetry is derived from successful permitted work and cannot be granted or published as a standalone action; approval requests are created only by the permission guard and execute nothing.

Every response/file read is checked against the latest signed agent permission (`mandate` in the SDK API) immediately before the effect. Revoked, expired, over-limit, or out-of-scope work stops. `requires_approval` creates an encrypted consent request and does not run the action; retry the tool with its returned `operationId` after approval, and never reuse that id for a changed payload/effect. Consent ids bind the complete proposal. Successful work records a signed receipt. Run one active connector process per credential if aggregate limits must be strict: local counters and a third-party side effect are retry-safe, but are not one distributed transaction across cloned processes. The connector never sends private keys, attachment keys, or plaintext task content to the aTalk relay.

The account description and channel status expose the connector/SDK version and latest validated aTalk
update advisory. OpenClaw logs one warning when a materially new update becomes available or required;
that advisory is operational metadata and never enters a model turn. This native plugin does not mutate
its host installation. Apply it through OpenClaw's supported plugin upgrade flow, then restart the host.
