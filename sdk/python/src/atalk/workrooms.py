from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Awaitable, Callable
from urllib.parse import urlparse

from .protocol import (
    attachment_part_descriptors,
    create_chunked_attachment_descriptor,
    decrypt_mandate_terms,
    decrypt_workroom_payload,
    encrypt_attachment,
    encrypt_attachment_chunk,
    encrypt_workroom_payload,
    hash_b64url_payload,
    hash_canonical,
    sign_canonical,
    split_encrypted_attachment,
    verify_canonical,
    verify_signed,
)

if TYPE_CHECKING:
    from .agent import Agent, RuntimeState

_MAX_PROCESSED_EVENTS = 10_000
_MAX_EVENT_FAILURES = 1_000
_DEFAULT_EVENT_FAILURE_ATTEMPTS = 3
_MAX_SAFE_INTEGER = 9_007_199_254_740_991
_TYPED_KINDS = {"plan", "artifact_version", "deliverable", "cost", "approval_request"}
_WORKROOM_EVENT_KINDS = {"message", "activity", *_TYPED_KINDS}


class WorkroomClient:
    """Durable E2EE Tasks/Workrooms API bound to an Agent identity."""

    def __init__(self, agent: Agent):
        self._agent = agent
        self._execution_lock = asyncio.Lock()

    async def list(self, cursor: str | None = None, limit: int = 50) -> dict[str, Any]:
        path = f"/v1/workrooms?limit={max(1, min(limit, 200))}"
        if cursor:
            from urllib.parse import quote
            path += f"&cursor={quote(cursor, safe='')}"
        page = await self._retry(lambda: self._agent._request("GET", path))
        return {**page, "workrooms": [self._open_detail(item) for item in page.get("workrooms", [])]}

    async def get(self, workroom_id: str, after_sequence: int = 0, event_limit: int = 100) -> dict[str, Any]:
        detail = await self._retry(lambda: self._agent._request(
            "GET", f"/v1/workrooms/{workroom_id}?afterSequence={max(0, after_sequence)}&eventLimit={max(1, min(event_limit, 200))}",
        ))
        return self._open_detail(detail)

    async def poll(
        self,
        workroom_id: str,
        handler: Callable[[dict[str, Any]], Awaitable[None] | None],
        *, limit: int = 100, cancel: asyncio.Event | None = None,
        max_event_failures: int = _DEFAULT_EVENT_FAILURE_ATTEMPTS,
        on_event_quarantined: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    ) -> int:
        """Invoke an agent handler only for events explicitly directed here.

        Every event is still authenticated and advances the durable automation
        cursor. Use ``read_audit_events`` for an operator-facing complete view;
        feeding that surface into a model loop would reintroduce ambiguous
        multi-agent routing.
        """
        cursor = self._agent._runtime_state.workroom_cursors.get(workroom_id, 0)
        failure_limit = (
            max(1, min(max_event_failures, 10))
            if isinstance(max_event_failures, int) and not isinstance(max_event_failures, bool)
            else _DEFAULT_EVENT_FAILURE_ATTEMPTS
        )
        while True:
            _raise_cancelled(cancel)
            page = await self._read_raw_event_page(workroom_id, cursor, limit, cancel=cancel)
            records = list(page.get("records", []))
            legacy_audit_only: list[bool] = []
            for record in records:
                if record.get("membershipSnapshot") is not None:
                    _event_membership_snapshot(record)
                legacy_audit_only.append(_is_legacy_audit_only_event(record))
            has_executable_candidate = any(not legacy for legacy in legacy_audit_only)
            detail = await self.get(workroom_id, cursor, 1) if has_executable_candidate else None
            for index, record in enumerate(records):
                _raise_cancelled(cancel)
                if legacy_audit_only[index]:
                    already_handled = _workroom_event_was_processed(
                        self._agent._runtime_state, record,
                    )
                    failure = None if already_handled else await self._quarantine_legacy_event(record)
                    cursor = int(record["sequence"])
                    if already_handled:
                        await self._commit_event_cursor(record)
                    if failure is not None and on_event_quarantined is not None:
                        observed = on_event_quarantined(failure)
                        if inspect.isawaitable(observed):
                            await observed
                    continue
                try:
                    decrypted = await self._decrypt_event(record, detail)
                except Exception as error:
                    failure = await self._record_event_failure(record, error, failure_limit)
                    if failure["status"] != "quarantined":
                        raise
                    cursor = int(record["sequence"])
                    if on_event_quarantined is not None:
                        observed = on_event_quarantined(failure)
                        if inspect.isawaitable(observed):
                            await observed
                    continue
                await self._clear_event_failure(record)
                if (not _workroom_event_was_processed(self._agent._runtime_state, record)
                        and bool(decrypted.get("directedToMe"))):
                    result = handler(_autonomous_event_view(decrypted))
                    if inspect.isawaitable(result):
                        await result
                cursor = int(record["sequence"])
                await self._commit_event_cursor(record)
            if page.get("nextAfterSequence") is None or not records:
                return cursor

    async def read_audit_events(
        self, workroom_id: str, after_sequence: int = 0, limit: int = 100,
        *, cancel: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """Read all verified events without advancing the agent-handler cursor."""
        return await self._read_event_page(workroom_id, after_sequence, limit, cancel=cancel)

    def list_quarantined_events(self, workroom_id: str | None = None) -> list[dict[str, Any]]:
        """Return durable dead letters skipped so later Task work can continue."""
        failures = getattr(self._agent._runtime_state, "workroom_event_failures", {})
        return sorted((dict(failure) for failure in failures.values()
                       if failure.get("status") == "quarantined"
                       and (workroom_id is None or failure.get("workroomId") == workroom_id)),
                      key=lambda failure: int(failure["sequence"]))

    async def watch(
        self, workroom_id: str, handler: Callable[[dict[str, Any]], Awaitable[None] | None],
        *, interval: float = 2.0, cancel: asyncio.Event | None = None,
        max_event_failures: int = _DEFAULT_EVENT_FAILURE_ATTEMPTS,
        on_event_quarantined: Callable[[dict[str, Any]], Awaitable[None] | None] | None = None,
    ) -> None:
        while not (cancel and cancel.is_set()):
            await self.poll(
                workroom_id, handler, cancel=cancel,
                max_event_failures=max_event_failures,
                on_event_quarantined=on_event_quarantined,
            )
            if cancel:
                try:
                    await asyncio.wait_for(cancel.wait(), timeout=max(0.25, interval))
                except TimeoutError:
                    pass
            else:
                await asyncio.sleep(max(0.25, interval))

    async def publish(
        self, workroom_id: str, thread_id: str, payload: dict[str, Any],
        *, event_id: str | None = None, idempotency_key: str | None = None,
        projection: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        credentials = self._agent._require_credentials()
        detail = await self.get(workroom_id, 0, 1)
        if detail["membership"]["role"] == "observer":
            raise ValueError("WORKROOM_READ_ONLY")
        content, projection = _prepare_payload_projection(_validate_payload(payload, thread_id), projection)
        recipients = _exact_recipients(detail)
        if credentials.peer["id"] not in {item["peerId"] for item in recipients}:
            raise ValueError("WORKROOM_MEMBERSHIP_REQUIRED")
        _validate_routing_bindings(content, detail, str(credentials.peer["id"]))
        actual_event_id = event_id or str(uuid.uuid4())
        now = _utc_now()
        envelope = encrypt_workroom_payload(
            envelope_id=actual_event_id,
            workroom_id=workroom_id,
            sender_peer_id=credentials.peer["id"],
            key_epoch=int(detail["workroom"]["currentKeyEpoch"]),
            payload=content,
            sender_signing_secret_key=credentials.keys.signing_secret_key,
            sender_encryption_secret_key=credentials.keys.encryption_secret_key,
            recipients=recipients,
            created_at=now,
        )
        event = {
            "eventId": actual_event_id,
            "workroomId": workroom_id,
            "threadId": thread_id,
            "actorPeerId": credentials.peer["id"],
            "kind": content["kind"],
            "envelope": envelope,
            "idempotencyKey": idempotency_key or f"event-{actual_event_id}",
            "createdAt": now,
        }
        body = {"event": event, **({"projection": projection} if projection else {})}
        result = await self._retry(lambda: self._agent._request(
            "POST", f"/v1/workrooms/{workroom_id}/events", body,
        ))
        return result["record"]

    async def message(
        self, workroom_id: str, thread_id: str, body: str,
        mentions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.publish(workroom_id, thread_id, {
            "version": 1, "kind": "message", "threadId": thread_id,
            "body": body, "mentions": mentions or [],
        })

    async def activity(
        self, workroom_id: str, thread_id: str, activity_type: str, summary: str,
        mentions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.publish(workroom_id, thread_id, {
            "version": 1, "kind": "activity", "threadId": thread_id,
            "activityType": activity_type, "summary": summary,
            "mentions": mentions or [], "sourceEventIds": [], "attributes": {},
        })

    async def plan(
        self, workroom_id: str, thread_id: str, *, plan_version: int,
        summary: str, steps: list[dict[str, Any]], plan_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.publish(workroom_id, thread_id, {
            "version": 1, "kind": "plan", "planVersion": plan_version,
            "summary": summary, "steps": steps, **({"planId": plan_id} if plan_id else {}),
        })

    async def artifact_version(
        self, workroom_id: str, thread_id: str, *, artifact_id: str,
        artifact_version: int, artifact_type: str, title: str, content_hash: str,
        attachments: list[dict[str, Any]] | None = None, description: str | None = None,
        mentions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        descriptors = attachments or []
        return await self.publish(workroom_id, thread_id, {
            "version": 1, "kind": "artifact_version", "artifactId": artifact_id,
            "artifactVersion": artifact_version, "artifactType": artifact_type,
            "title": title, "contentHash": content_hash,
            "attachmentIds": [str(item["id"]) for item in descriptors],
            "attachments": descriptors, "mentions": mentions or [],
            **({"description": description} if description else {}),
        })

    async def deliverable(
        self, workroom_id: str, thread_id: str, *, artifact_id: str,
        artifact_version: int, artifact_version_id: str,
        acceptance_criteria: list[str], note: str | None = None,
        mentions: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        return await self.publish(workroom_id, thread_id, {
            "version": 1, "kind": "deliverable", "artifactId": artifact_id,
            "artifactVersion": artifact_version, "artifactVersionId": artifact_version_id,
            "acceptanceCriteria": acceptance_criteria, "mentions": mentions or [],
            **({"note": note} if note else {}),
        })

    async def publish_mandated(self, request: dict[str, Any]) -> dict[str, Any]:
        """Preferred agent boundary for publishing one Task event."""
        content = _validate_payload(dict(request["payload"]), str(request["threadId"]))
        if content["kind"] == "cost":
            raise ValueError("WORKROOM_COST_MUST_BE_DERIVED_FROM_AN_EXECUTED_ACTION")
        if content["kind"] == "approval_request":
            raise ValueError("WORKROOM_APPROVAL_REQUESTS_ARE_CREATED_BY_THE_MANDATE_GUARD")
        detail = await self.get(str(request["workroomId"]), 0, 1)
        participants = _active_peer_ids(detail)
        action = default_workroom_action(str(content["kind"]))
        if request.get("action") not in (None, action):
            raise ValueError("WORKROOM_ACTION_KIND_MISMATCH")
        data_accesses = request.get("dataAccesses")
        if data_accesses is None and content["kind"] == "artifact_version":
            data_accesses = [{
                "resource": "workroom.attachments", "permission": "write",
                "recipientPeerIds": participants, "classification": "workroom",
            }]
        mandate_request = {
            **{key: value for key, value in request.items() if key not in {"payload", "publish"}},
            "action": action,
            "participantPeerIds": request.get("participantPeerIds", participants),
            "dataAccesses": data_accesses or [],
            "volumeDelta": request.get("volumeDelta", _payload_volume(content)),
            "summary": str(request.get("summary") or _publication_summary(content)),
            "effect": str(request.get("effect") or _publication_effect(content)),
        }

        async def publish(_context: dict[str, Any]) -> dict[str, Any]:
            options = request.get("publish") or {}
            record = await self.publish(
                str(request["workroomId"]), str(request["threadId"]), content,
                event_id=options.get("eventId") or _deterministic_uuid(f"{request['operationId']}:event"),
                idempotency_key=options.get("idempotencyKey") or f"operation-{request['operationId']}",
                projection=options.get("projection"),
            )
            return {"value": record}

        return await self.execute_mandated_action(mandate_request, publish)

    async def upload_attachment(
        self, workroom_id: str, data: bytes, name: str,
        mime_type: str = "application/octet-stream",
    ) -> dict[str, Any]:
        descriptor, ciphertext = encrypt_attachment(
            attachment_id=str(uuid.uuid4()), data=data, name=name, mime_type=mime_type,
        )
        descriptor, parts = split_encrypted_attachment(descriptor, ciphertext, lambda: str(uuid.uuid4()))
        try:
            for part_id, part in parts:
                await self._agent._upload_workroom_attachment(workroom_id, part_id, part)
            return descriptor
        except BaseException:
            await asyncio.gather(
                *(self._agent._delete_attachment_part(part_id) for part_id, _ in parts),
                return_exceptions=True,
            )
            raise

    async def upload_attachment_file(
        self, workroom_id: str, file_path: str | Path, *, name: str | None = None,
        mime_type: str | None = None, progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        path = Path(file_path).expanduser().resolve()
        if not path.is_file():
            raise ValueError("ATTACHMENT_NOT_A_FILE")
        descriptor = create_chunked_attachment_descriptor(
            attachment_id=str(uuid.uuid4()), size=path.stat().st_size, name=name or path.name,
            mime_type=mime_type or _mime_type(path), next_id=lambda: str(uuid.uuid4()),
        )
        transferred = 0
        try:
            with path.open("rb") as source:
                for index, chunk in enumerate(descriptor["chunks"]):
                    _raise_cancelled(cancel)
                    plaintext = source.read(int(chunk["plaintextSize"]))
                    if len(plaintext) != int(chunk["plaintextSize"]):
                        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
                    await self._agent._upload_workroom_attachment(
                        workroom_id, chunk["id"], encrypt_attachment_chunk(plaintext, descriptor, index), cancel=cancel,
                    )
                    transferred += len(plaintext)
                    if progress:
                        progress(transferred, int(descriptor["size"]))
            return descriptor
        except BaseException:
            await asyncio.gather(
                *(self._agent._delete_attachment_part(str(item["id"])) for item in attachment_part_descriptors(descriptor)),
                return_exceptions=True,
            )
            raise

    async def download_attachment(self, descriptor: dict[str, Any]) -> bytes:
        return await self._agent._download_attachment(descriptor)

    async def save_attachment_to(
        self, descriptor: dict[str, Any], file_path: str | Path,
        *, progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
    ) -> Path:
        return await self._agent._download_attachment_to_file(
            descriptor, Path(file_path).expanduser().resolve(), progress, cancel,
        )

    async def save_attachment_to_mandated(self, request: dict[str, Any]) -> dict[str, Any]:
        descriptor = dict(request["descriptor"])
        detail = await self.get(str(request["workroomId"]), 0, 1)
        participants = _active_peer_ids(detail)
        mandate_request = {
            **{key: value for key, value in request.items() if key not in {"descriptor", "filePath", "progress", "cancel"}},
            "action": "file.read",
            "participantPeerIds": request.get("participantPeerIds", participants),
            "dataAccesses": request.get("dataAccesses", [{
                "resource": "workroom.attachments", "permission": "read",
                "recipientPeerIds": [], "classification": "workroom",
            }]),
            "volumeDelta": request.get("volumeDelta", {
                "messages": 0, "files": 1, "totalBytes": int(descriptor.get("size", 0)),
                "actions": 1, "custom": {},
            }),
            "summary": str(request.get("summary") or f"Read {descriptor.get('name', 'Task file')}"),
            "effect": str(request.get("effect") or "Decrypt one Task file inside the configured agent runtime"),
        }

        async def save(_context: dict[str, Any]) -> dict[str, Any]:
            path = await self.save_attachment_to(
                descriptor, request["filePath"], progress=request.get("progress"), cancel=request.get("cancel"),
            )
            return {"value": str(path)}

        return await self.execute_mandated_action(mandate_request, save)

    async def submit_file_mandated(self, request: dict[str, Any]) -> dict[str, Any]:
        """Guard, encrypt, upload and publish one Task file."""
        path = Path(request["filePath"]).expanduser().resolve()
        if not path.is_file():
            raise ValueError("ATTACHMENT_NOT_A_FILE")
        detail = await self.get(str(request["workroomId"]), 0, 1)
        participants = _active_peer_ids(detail)
        name = str(request.get("name") or path.name)
        mandate_request = {
            **{key: value for key, value in request.items() if key not in {
                "filePath", "name", "mimeType", "title", "description", "artifactType",
                "artifactId", "artifactVersion", "mentions", "progress", "cancel",
            }},
            "action": "file.create",
            "participantPeerIds": request.get("participantPeerIds", participants),
            "dataAccesses": request.get("dataAccesses", [{
                "resource": "workroom.attachments", "permission": "write",
                "recipientPeerIds": participants, "classification": "workroom",
            }]),
            "volumeDelta": {
                "messages": 0, "files": 1, "totalBytes": path.stat().st_size,
                "actions": 1, "custom": {},
            },
            "summary": str(request.get("summary") or f"Add file: {request.get('title') or name}"),
            "effect": str(request.get("effect") or "Encrypt and share one file with every current Task participant"),
        }

        async def submit(_context: dict[str, Any]) -> dict[str, Any]:
            descriptor = await self.upload_attachment_file(
                str(request["workroomId"]), path, name=name,
                mime_type=request.get("mimeType"), progress=request.get("progress"), cancel=request.get("cancel"),
            )
            try:
                artifact_id = str(request.get("artifactId") or _deterministic_uuid(f"{request['operationId']}:artifact"))
                artifact_version = int(request.get("artifactVersion", 1))
                artifact_version_id = _deterministic_uuid(f"{request['operationId']}:artifact-version")
                record = await self.publish(str(request["workroomId"]), str(request["threadId"]), {
                    "version": 1, "kind": "artifact_version", "artifactId": artifact_id,
                    "artifactVersion": artifact_version,
                    "artifactVersionId": artifact_version_id,
                    "artifactType": str(request.get("artifactType") or "file"),
                    "title": str(request.get("title") or name),
                    **({"description": str(request["description"])} if request.get("description") else {}),
                    "mediaType": descriptor["mimeType"], "fileName": descriptor["name"],
                    "attachmentIds": [descriptor["id"]], "attachments": [descriptor],
                    "contentHash": _hash_file(path), "mentions": request.get("mentions", []),
                }, event_id=_deterministic_uuid(f"{request['operationId']}:artifact-event"),
                   idempotency_key=f"artifact-{request['operationId']}")
                return {"value": {
                    "descriptor": descriptor,
                    "artifactId": artifact_id,
                    "artifactVersion": artifact_version,
                    "artifactVersionId": artifact_version_id,
                    "record": record,
                }}
            except BaseException:
                await asyncio.gather(
                    *(self._agent._delete_attachment_part(str(item["id"])) for item in attachment_part_descriptors(descriptor)),
                    return_exceptions=True,
                )
                raise

        return await self.execute_mandated_action(mandate_request, submit)

    async def guard_mandate_use(
        self, request: dict[str, Any], *, create_approval: bool = True,
    ) -> dict[str, Any]:
        credentials = self._agent._require_credentials()
        detail = await self.get(request["workroomId"], 0, 1)
        workroom_ended = _workroom_stop_reason(detail["workroom"])
        if workroom_ended:
            return {"status": "denied", "code": "MANDATE_ENDED", "detail": workroom_ended}
        if detail.get("membership", {}).get("role") == "observer":
            return {"status": "denied", "code": "MANDATE_MISMATCH", "detail": "observer role is read-only"}
        views = [
            view for view in detail.get("latestMandates", [])
            if view["mandate"]["actorPeerId"] == credentials.peer["id"]
            and (not request.get("mandateId") or view["mandate"]["mandateId"] == request["mandateId"])
        ]
        if not views:
            return {"status": "denied", "code": "MANDATE_MISMATCH"}
        view = max(views, key=lambda item: int(item["mandate"]["revision"]))
        signed = _open_mandate(view, detail, credentials)
        active_roles = {
            str(item.get("membership", {}).get("peerId")): item.get("membership", {}).get("role")
            for item in detail.get("members", [])
            if not item.get("membership", {}).get("leftAt")
        }
        mandate_parties = (
            signed["mandate"]["actorPeerId"],
            signed["mandate"]["principalPeerId"],
            signed["mandate"]["issuedByPeerId"],
        )
        if any(active_roles.get(str(peer_id)) in {None, "observer"} for peer_id in mandate_parties):
            return {
                "status": "denied", "code": "MANDATE_MISMATCH",
                "detail": "mandate parties must remain active non-observer members",
            }
        if view.get("revocation"):
            _verify_revocation(view["revocation"], detail)
            return {"status": "denied", "code": "MANDATE_ENDED", "detail": "revoked"}
        approvals = _verified_approvals(detail, signed, request, credentials)
        effective_request = self._with_durable_usage(request, signed)
        decision = _evaluate_mandate(signed["mandate"], effective_request, credentials.peer["id"], approvals)
        if decision["status"] != "requires_approval":
            return {**decision, **({"mandate": signed} if decision["status"] == "permitted" else {})}
        request_ids = []
        if create_approval:
            request_ids = await self._ensure_approval_requests(detail, signed, request, decision)
        return {**decision, "requestIds": request_ids}

    async def execute_mandated_action(
        self, request: dict[str, Any],
        effect: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        async with self._execution_lock:
            initial = await self.guard_mandate_use(request)
            if initial["status"] != "permitted":
                return initial
            final_guard = await self.guard_mandate_use(request, create_approval=False)
            if final_guard["status"] != "permitted":
                return final_guard
            result = await effect({"operationId": request["operationId"], "mandate": final_guard["mandate"]})
            await self._record_durable_usage(request, final_guard["mandate"])
            for index, cost in enumerate(result.get("costs", [])):
                await self.publish(
                    request["workroomId"], request["threadId"], cost,
                    event_id=_deterministic_uuid(f"{request['operationId']}:cost:{index}"),
                    idempotency_key=f"cost-{request['operationId']}-{index}",
                )
            receipt = await self._append_receipt(request, result)
            return {"status": "executed", "value": result.get("value"), "receipt": receipt}

    def _open_detail(self, detail: dict[str, Any]) -> dict[str, Any]:
        credentials = self._agent._require_credentials()
        envelope = detail["workroom"]["descriptorEnvelope"]
        if detail["workroom"]["descriptorHash"] != hash_canonical(envelope):
            raise ValueError("WORKROOM_DESCRIPTOR_HASH_MISMATCH")
        sender = _required_peer(detail, str(envelope["senderPeerId"]))
        descriptor = decrypt_workroom_payload(
            envelope=envelope, recipient_peer_id=credentials.peer["id"],
            recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
            sender_encryption_public_key=sender["encryptionPublicKey"],
            sender_signing_public_key=sender["signingPublicKey"],
        )
        _validate_descriptor(descriptor)
        return {**detail, "descriptor": descriptor}

    def _with_durable_usage(self, request: dict[str, Any], signed: dict[str, Any]) -> dict[str, Any]:
        usage = getattr(self._agent._runtime_state, "workroom_mandate_usage", {}).get(_mandate_usage_key(signed))
        if not isinstance(usage, dict):
            return request
        already_completed = str(request["operationId"]) in usage.get("completedOperations", {})
        stored_volume = _normalize_volume(usage.get("volume"))
        now = datetime.now(timezone.utc)
        stored_spend: dict[str, int] = {}
        for limit in signed["mandate"].get("spendLimits", []):
            key = f"{limit['currency']}:{limit['period']}"
            entry = usage.get("spend", {}).get(key, {}) if isinstance(usage.get("spend"), dict) else {}
            stored_spend[key] = int(entry.get("amountMinor", 0)) if entry.get("bucket") == _spend_bucket(limit["period"], now) else 0
        effective = {
            **request,
            "volumeUsed": _maximum_volume(request.get("volumeUsed"), stored_volume),
            "spendUsedMinorByLimit": _maximum_counters(request.get("spendUsedMinorByLimit"), stored_spend),
        }
        if already_completed:
            effective["volumeDelta"] = _empty_volume()
            if request.get("spend"):
                effective["spend"] = {**request["spend"], "amountMinor": 0}
        return effective

    async def _record_durable_usage(self, request: dict[str, Any], signed: dict[str, Any]) -> None:
        now = datetime.now(timezone.utc)

        def record(state: RuntimeState) -> None:
            usage_map = state.workroom_mandate_usage
            key = _mandate_usage_key(signed)
            usage = usage_map.get(key) if isinstance(usage_map.get(key), dict) else {
                "volume": _empty_volume(), "spend": {}, "completedOperations": {},
            }
            completed = usage.get("completedOperations") if isinstance(usage.get("completedOperations"), dict) else {}
            operation_id = str(request["operationId"])
            if operation_id in completed:
                return
            usage["volume"] = _add_volume(
                _maximum_volume(request.get("volumeUsed"), usage.get("volume")),
                request.get("volumeDelta"),
            )
            spend_entries = usage.get("spend") if isinstance(usage.get("spend"), dict) else {}
            spend = request.get("spend")
            if spend:
                for limit in signed["mandate"].get("spendLimits", []):
                    if limit["currency"] != spend["currency"]:
                        continue
                    counter_key = f"{limit['currency']}:{limit['period']}"
                    bucket = _spend_bucket(limit["period"], now)
                    current = spend_entries.get(counter_key, {})
                    current_value = int(current.get("amountMinor", 0)) if current.get("bucket") == bucket else 0
                    supplied = int(request.get("spendUsedMinorByLimit", {}).get(counter_key, 0))
                    spend_entries[counter_key] = {
                        "bucket": bucket,
                        "amountMinor": _safe_add(max(current_value, supplied), int(spend["amountMinor"])),
                    }
            usage["spend"] = spend_entries
            completed[operation_id] = now.isoformat().replace("+00:00", "Z")
            while len(completed) > 10_000:
                completed.pop(next(iter(completed)))
            usage["completedOperations"] = completed
            usage_map[key] = usage

        await self._agent._mutate_runtime_state(record)

    async def _decrypt_event(self, record: dict[str, Any], detail: dict[str, Any]) -> dict[str, Any]:
        credentials = self._agent._require_credentials()
        event = record["event"]
        membership_snapshot = _event_membership_snapshot(record)
        legacy_audit_only = _is_legacy_audit_only_event(record)
        historical_actor = next((item for item in membership_snapshot or []
                                 if item["peerId"] == event["actorPeerId"]), None)
        current_actor = _peer(detail, event["actorPeerId"])
        if (historical_actor is not None and historical_actor.get("signingPublicKey")
                and historical_actor.get("encryptionPublicKey")):
            actor = _peer_from_event_snapshot(historical_actor, current_actor)
        else:
            actor = current_actor
        if actor is None:
            actor = await self._agent._request("GET", f"/v1/peers/{event['actorPeerId']}/keys")
        content = decrypt_workroom_payload(
            envelope=event["envelope"], recipient_peer_id=credentials.peer["id"],
            recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
            sender_encryption_public_key=actor["encryptionPublicKey"],
            sender_signing_public_key=actor["signingPublicKey"],
        )
        if content.get("kind") != event["kind"]:
            raise ValueError("WORKROOM_EVENT_KIND_MISMATCH")
        content = _validate_payload(content, str(event["threadId"]))
        if membership_snapshot:
            _validate_routing_bindings(
                content, _snapshot_routing_detail(membership_snapshot),
                str(event["actorPeerId"]), allow_observer_targets=True,
            )
        _validate_projection(record.get("projection"), content)
        historical_recipient = next((item for item in membership_snapshot or []
                                     if item["peerId"] == credentials.peer["id"]), None)
        current_role = str(detail.get("membership", {}).get("role", ""))
        historical_role = str((historical_recipient or {}).get("role", ""))
        routing = _routing_context(
            content,
            recipient_peer_id=str(credentials.peer["id"]),
            actor_peer_id=str(event["actorPeerId"]),
            recipient_role=("observer" if legacy_audit_only
                            or "observer" in {current_role, historical_role} else current_role),
        )
        return {
            **record, "actor": actor, "content": content,
            "routing": routing,
            "directedToMe": routing["directedToMe"],
        }

    async def _read_event_page(
        self, workroom_id: str, after_sequence: int, limit: int,
        *, cancel: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        page = await self._read_raw_event_page(
            workroom_id, after_sequence, limit, cancel=cancel,
        )
        detail = await self.get(workroom_id, after_sequence, 1)
        events = []
        for record in page["records"]:
            _raise_cancelled(cancel)
            events.append(await self._decrypt_event(record, detail))
        return {"events": events, "nextAfterSequence": page.get("nextAfterSequence")}

    async def _read_raw_event_page(
        self, workroom_id: str, after_sequence: int, limit: int,
        *, cancel: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        cursor = after_sequence if isinstance(after_sequence, int) and not isinstance(after_sequence, bool) and after_sequence >= 0 else 0
        page_size = limit if isinstance(limit, int) and not isinstance(limit, bool) else 100
        page_size = max(1, min(page_size, 500))
        page = await self._retry(lambda: self._agent._request(
            "GET", f"/v1/workrooms/{workroom_id}/events?afterSequence={cursor}&limit={page_size}",
        ), cancel=cancel)
        records = _validate_raw_workroom_event_page(workroom_id, cursor, page)
        return {"records": records, "nextAfterSequence": page.get("nextAfterSequence")}

    async def _quarantine_legacy_event(self, record: dict[str, Any]) -> dict[str, Any]:
        event = record["event"]
        failure_key = _workroom_event_processing_id(record)
        failure = {
            "workroomId": str(event["workroomId"]),
            "eventId": str(event["eventId"]),
            "envelopeId": failure_key,
            "sequence": int(record["sequence"]),
            "attempts": 0,
            "reason": "legacy_audit_only",
            "lastError": "Legacy event has no complete event-time recipient-key binding",
            "status": "quarantined",
            "updatedAt": _utc_now(),
        }

        def quarantine(state: RuntimeState) -> None:
            state.workroom_event_failures.pop(failure_key, None)
            state.workroom_event_failures[failure_key] = dict(failure)
            state.workroom_cursors[failure["workroomId"]] = failure["sequence"]
            state.processed_workroom_events[failure_key] = True
            _prune_runtime_event_state(state)

        await self._agent._mutate_runtime_state(quarantine)
        return failure

    async def _record_event_failure(
        self, record: dict[str, Any], error: Exception, maximum_attempts: int,
    ) -> dict[str, Any]:
        event = record["event"]
        event_id = str(event["eventId"])
        failure_key = _workroom_event_processing_id(record)
        workroom_id = str(event["workroomId"])
        sequence = int(record["sequence"])
        failure: dict[str, Any] = {}

        def remember(state: RuntimeState) -> None:
            previous = state.workroom_event_failures.get(failure_key)
            attempts = (
                int(previous.get("attempts", 0)) + 1
                if isinstance(previous, dict)
                and previous.get("reason") == "processing_failed"
                and previous.get("workroomId") == workroom_id
                and previous.get("sequence") == sequence
                else 1
            )
            failure.update({
                "workroomId": workroom_id,
                "eventId": event_id,
                "envelopeId": failure_key,
                "sequence": sequence,
                "attempts": attempts,
                "reason": "processing_failed",
                "lastError": _event_failure_message(error),
                "status": "quarantined" if attempts >= maximum_attempts else "retrying",
                "updatedAt": _utc_now(),
            })
            state.workroom_event_failures.pop(failure_key, None)
            state.workroom_event_failures[failure_key] = dict(failure)
            if failure["status"] == "quarantined":
                state.workroom_cursors[workroom_id] = sequence
                state.processed_workroom_events[failure_key] = True
            _prune_runtime_event_state(state)

        await self._agent._mutate_runtime_state(remember)
        return failure

    async def _clear_event_failure(self, record: dict[str, Any]) -> None:
        failure_key = _workroom_event_processing_id(record)
        if failure_key not in self._agent._runtime_state.workroom_event_failures:
            return

        def clear(state: RuntimeState) -> None:
            state.workroom_event_failures.pop(failure_key, None)

        await self._agent._mutate_runtime_state(clear)

    async def _commit_event_cursor(self, record: dict[str, Any]) -> None:
        workroom_id = str(record["event"]["workroomId"])
        processing_id = _workroom_event_processing_id(record)
        sequence = int(record["sequence"])

        def commit(state: RuntimeState) -> None:
            state.workroom_cursors[workroom_id] = sequence
            state.processed_workroom_events[processing_id] = True
            _prune_runtime_event_state(state)

        await self._agent._mutate_runtime_state(commit)

    async def _ensure_approval_requests(
        self, detail: dict[str, Any], signed: dict[str, Any], request: dict[str, Any], decision: dict[str, Any],
    ) -> list[str]:
        mandate = signed["mandate"]
        if decision.get("reason") == "DELEGATION":
            thresholds = [{"id": "delegation", "requiredApprovals": 1, "approverPeerIds": [mandate["principalPeerId"]]}]
        else:
            thresholds = [item for item in mandate.get("approvalThresholds", []) if item["id"] in decision["thresholdIds"]]
        request_ids = []
        if not str(request.get("summary", "")).strip() or not str(request.get("effect", "")).strip():
            raise ValueError("APPROVAL_INFORMED_CONSENT_REQUIRED: summary and effect are required")
        if _is_purchase_action(str(request["action"])) and not request.get("financialImpact"):
            raise ValueError("APPROVAL_FINANCIAL_IMPACT_REQUIRED")
        for threshold in thresholds:
            request_id = _approval_request_id(request, signed, str(threshold["id"]))
            request_ids.append(request_id)
            if any(item["requestId"] == request_id and item["status"] == "pending" for item in detail.get("approvals", [])):
                continue
            await self.publish(request["workroomId"], request["threadId"], {
                "version": 1, "kind": "approval_request", "requestId": request_id,
                "thresholdId": threshold["id"], "action": request["action"],
                "rationale": request.get("rationale") or f"Approve {request['action']}",
                "summary": str(request["summary"]).strip(), "effect": str(request["effect"]).strip(),
                **({"target": request["target"]} if request.get("target") else {}),
                **({"financialImpact": request["financialImpact"]} if request.get("financialImpact") else {}),
                "dataCategories": request.get("dataCategories", []),
                "mandateId": mandate["mandateId"], "relatedEventIds": [],
                "requestedApproverPeerIds": threshold["approverPeerIds"],
                "requiredApprovals": threshold["requiredApprovals"],
            }, event_id=_deterministic_uuid(f"{request_id}:event"), idempotency_key=f"approval-{request_id}", projection={
                "kind": "approval_request", "id": request_id,
                "requiredApprovals": threshold["requiredApprovals"],
                "eligiblePeerIds": threshold["approverPeerIds"],
            })
        return request_ids

    async def _append_receipt(self, request: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        credentials = self._agent._require_credentials()
        for attempt in range(3):
            detail = await self.get(request["workroomId"], 0, 1)
            receipt_payload = {
                "version": 1, "receiptId": _deterministic_uuid(f"{request['operationId']}:receipt"),
                "workroomId": request["workroomId"], "actorPeerId": credentials.peer["id"],
                "signingPublicKey": credentials.peer["signingPublicKey"],
                "event": "cost_recorded" if result.get("costs") else "event_appended",
                "idempotencyKey": f"effect-{request['operationId']}",
                "payloadHash": hash_canonical({
                    "operationId": request["operationId"], "action": request["action"],
                    "result": result.get("value"), "costs": result.get("costs", []),
                }),
                "previousReceiptHash": detail.get("latestReceiptHash"), "outcome": "recorded", "occurredAt": _utc_now(),
            }
            signed = {"receipt": receipt_payload, "signature": sign_canonical(receipt_payload, credentials.keys.signing_secret_key)}
            try:
                await self._agent._request(
                    "POST", f"/v1/workrooms/{request['workroomId']}/receipts", {"signedReceipt": signed},
                )
                return signed
            except Exception:
                if attempt == 2:
                    raise
        raise RuntimeError("RECEIPT_WRITE_FAILED")

    async def _retry(
        self, operation: Callable[[], Awaitable[dict[str, Any]]], attempts: int = 3,
        cancel: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        last_error: Exception | None = None
        for attempt in range(max(1, min(attempts, 5))):
            _raise_cancelled(cancel)
            try:
                return await operation()
            except Exception as error:
                last_error = error
                if attempt + 1 < attempts:
                    await asyncio.sleep(0.25 * (2 ** attempt))
        raise last_error or RuntimeError("WORKROOM_REQUEST_FAILED")


def _event_failure_message(error: Exception) -> str:
    return f"{type(error).__name__}: {error}"[:512]


def _workroom_event_processing_id(record: dict[str, Any]) -> str:
    return str(record["event"]["envelope"]["envelopeId"])


def _workroom_event_was_processed(state: RuntimeState, record: dict[str, Any]) -> bool:
    return bool(state.processed_workroom_events.get(_workroom_event_processing_id(record)))


def _validate_raw_workroom_event_page(
    workroom_id: str, cursor: int, page: dict[str, Any],
) -> list[dict[str, Any]]:
    raw_records = page.get("events")
    if not isinstance(raw_records, list):
        raise ValueError("WORKROOM_EVENT_PAGE_INVALID")
    records: list[dict[str, Any]] = []
    previous_sequence = cursor
    for record in raw_records:
        if not isinstance(record, dict):
            raise ValueError("WORKROOM_EVENT_METADATA_INVALID")
        sequence = record.get("sequence")
        if (
            not isinstance(sequence, int)
            or isinstance(sequence, bool)
            or sequence <= previous_sequence
            or sequence > _MAX_SAFE_INTEGER
        ):
            raise ValueError("WORKROOM_EVENT_SEQUENCE_INVALID")
        event = record.get("event")
        envelope = event.get("envelope") if isinstance(event, dict) else None
        if not isinstance(event, dict) or not isinstance(envelope, dict):
            raise ValueError("WORKROOM_EVENT_METADATA_INVALID")
        event_ids = [
            event.get("eventId"), event.get("workroomId"), event.get("threadId"),
            event.get("actorPeerId"), envelope.get("envelopeId"),
            envelope.get("workroomId"), envelope.get("senderPeerId"),
        ]
        if not all(_is_uuid(value) for value in event_ids):
            raise ValueError("WORKROOM_EVENT_METADATA_INVALID")
        if event.get("kind") not in _WORKROOM_EVENT_KINDS:
            raise ValueError("WORKROOM_EVENT_METADATA_INVALID")
        if event["workroomId"] != workroom_id or envelope["workroomId"] != workroom_id:
            raise ValueError("WORKROOM_EVENT_PAGE_WORKROOM_MISMATCH")
        if (
            envelope["senderPeerId"] != event["actorPeerId"]
            or not isinstance(event.get("createdAt"), str)
            or envelope.get("createdAt") != event["createdAt"]
        ):
            raise ValueError("WORKROOM_EVENT_METADATA_MISMATCH")
        previous_sequence = sequence
        records.append(record)
    next_after_sequence = page.get("nextAfterSequence")
    if next_after_sequence is not None and (
        not isinstance(next_after_sequence, int)
        or isinstance(next_after_sequence, bool)
        or next_after_sequence > _MAX_SAFE_INTEGER
        or not records
        or next_after_sequence != records[-1]["sequence"]
    ):
        raise ValueError("WORKROOM_EVENT_CURSOR_INVALID")
    return records


def _is_uuid(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
        return True
    except ValueError:
        return False


def _prune_runtime_event_state(state: RuntimeState) -> None:
    while len(state.processed_workroom_events) > _MAX_PROCESSED_EVENTS:
        state.processed_workroom_events.pop(next(iter(state.processed_workroom_events)))
    while len(state.workroom_event_failures) > _MAX_EVENT_FAILURES:
        state.workroom_event_failures.pop(next(iter(state.workroom_event_failures)))


def _open_mandate(view: dict[str, Any], detail: dict[str, Any], credentials: Any) -> dict[str, Any]:
    record = view["mandate"]
    issuer = _required_peer(detail, record["issuedByPeerId"])
    commitment = record["signedCommitment"]
    if issuer["signingPublicKey"] != record["issuerSigningPublicKey"] or not verify_signed(
        commitment, "signature", issuer["signingPublicKey"],
    ):
        raise ValueError("INVALID_MANDATE_COMMITMENT")
    envelope = record["encryptedTermsEnvelope"]
    if commitment["commitment"]["encryptedTermsHash"] != hash_canonical(envelope):
        raise ValueError("INVALID_MANDATE_COMMITMENT")
    signed = decrypt_mandate_terms(
        envelope=envelope, recipient_peer_id=credentials.peer["id"],
        recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
        sender_encryption_public_key=issuer["encryptionPublicKey"],
        sender_signing_public_key=issuer["signingPublicKey"],
    )
    if not verify_signed(signed, "signature", issuer["signingPublicKey"]):
        raise ValueError("INVALID_MANDATE_TERMS")
    terms_hash = hash_canonical(signed)
    terms = signed["mandate"]
    bound = commitment["commitment"]
    if (
        terms_hash != bound["termsHash"] or terms["mandateId"] != bound["mandateId"]
        or terms["revision"] != bound["revision"] or terms.get("workroomId") != detail["workroom"]["id"]
        or terms["actorPeerId"] != record["actorPeerId"]
    ):
        raise ValueError("INVALID_MANDATE_TERMS")
    return signed


def _verify_revocation(revocation: dict[str, Any], detail: dict[str, Any]) -> None:
    signed = revocation["signedRevocation"]
    peer = _required_peer(detail, signed["revocation"]["revokedByPeerId"])
    if peer["signingPublicKey"] != revocation["revokerSigningPublicKey"] or not verify_signed(
        signed, "signature", peer["signingPublicKey"],
    ):
        raise ValueError("INVALID_MANDATE_REVOCATION")


def _verified_approvals(
    detail: dict[str, Any], signed: dict[str, Any], request: dict[str, Any], credentials: Any,
) -> list[dict[str, Any]]:
    evidence = []
    for threshold in signed["mandate"].get("approvalThresholds", []):
        decision_ids: list[str] = []
        approvers: set[str] = set()
        for approval in detail.get("approvals", []):
            expected_request_id = _approval_request_id(request, signed, str(threshold["id"]))
            if approval["requestId"] != expected_request_id:
                continue
            envelope = approval["requestEnvelope"]
            if approval["status"] != "approved" or approval["requestCiphertextHash"] != envelope["ciphertextHash"]:
                continue
            if approval.get("expiresAt") and datetime.now(timezone.utc) >= _instant(approval["expiresAt"]):
                continue
            requester = _required_peer(detail, approval["requestedByPeerId"])
            payload = decrypt_workroom_payload(
                envelope=envelope, recipient_peer_id=credentials.peer["id"],
                recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
                sender_encryption_public_key=requester["encryptionPublicKey"],
                sender_signing_public_key=requester["signingPublicKey"],
            )
            if (
                payload.get("requestId") != approval["requestId"] or payload.get("thresholdId") != threshold["id"]
                or envelope["envelopeId"] != approval["sourceEventId"]
                or envelope["workroomId"] != approval["workroomId"]
                or envelope["senderPeerId"] != approval["requestedByPeerId"]
                or approval["requestedByPeerId"] != credentials.peer["id"]
                or payload.get("action") != request["action"]
                or payload.get("mandateId") != signed["mandate"]["mandateId"]
                or not _approval_payload_matches_request(payload, request)
                or int(payload.get("requiredApprovals", 0)) != int(threshold["requiredApprovals"])
                or set(payload.get("requestedApproverPeerIds", [])) != set(threshold["approverPeerIds"])
                or set(approval["eligiblePeerIds"]) != set(threshold["approverPeerIds"])
                or payload.get("expiresAt") != approval.get("expiresAt")
            ):
                continue
            for record in approval.get("decisions", []):
                decision = record["signedDecision"]["decision"]
                signer = _peer(detail, decision["decidedByPeerId"])
                if (
                    not signer or signer["signingPublicKey"] != record["signingPublicKey"]
                    or signer["id"] not in approval["eligiblePeerIds"] or decision["requestId"] != approval["requestId"]
                    or decision["workroomId"] != detail["workroom"]["id"]
                    or decision["requestCiphertextHash"] != approval["requestCiphertextHash"]
                    or decision["decision"] != "approve"
                    or (approval.get("expiresAt") and _instant(decision["decidedAt"]) >= _instant(approval["expiresAt"]))
                    or not verify_signed(record["signedDecision"], "signature", signer["signingPublicKey"])
                ):
                    continue
                decision_ids.append(decision["decisionId"])
                approvers.add(signer["id"])
        if len(approvers) >= int(threshold["requiredApprovals"]):
            evidence.append({"thresholdId": threshold["id"], "decisionIds": decision_ids, "approverPeerIds": list(approvers)})
    return evidence


def _evaluate_mandate(
    mandate: dict[str, Any], request: dict[str, Any], acting_peer_id: str,
    approvals: list[dict[str, Any]],
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    if request.get("mandateId", mandate["mandateId"]) != mandate["mandateId"]:
        return {"status": "denied", "code": "MANDATE_MISMATCH"}
    if now < _instant(mandate["validFrom"]):
        return {"status": "denied", "code": "MANDATE_NOT_YET_VALID"}
    if now >= _instant(mandate["validUntil"]):
        return {"status": "denied", "code": "MANDATE_EXPIRED"}
    known_end_conditions = {item["id"] for item in mandate.get("endConditions", [])}
    deadline_ended = any(
        item.get("type") == "deadline" and now >= _instant(item["at"])
        for item in mandate.get("endConditions", [])
    )
    if deadline_ended or any(item in known_end_conditions for item in request.get("metEndConditionIds", [])):
        return {"status": "denied", "code": "MANDATE_ENDED"}
    if acting_peer_id != mandate["actorPeerId"]:
        delegation = mandate["delegation"]
        if not delegation["allowed"] or acting_peer_id not in delegation.get("allowedDelegatePeerIds", []):
            return {"status": "denied", "code": "DELEGATION_DENIED"}
        depth = int(request.get("delegationDepth", 0))
        if depth < 1 or depth > int(delegation.get("maxDepth", 0)):
            return {"status": "denied", "code": "DELEGATION_DEPTH_EXCEEDED"}
        if delegation.get("requirePrincipalApproval") and not request.get("principalApprovedDelegation", False):
            return {"status": "requires_approval", "thresholdIds": [], "reason": "DELEGATION"}
    elif int(request.get("delegationDepth", 0)) != 0:
        return {"status": "denied", "code": "DELEGATION_DEPTH_EXCEEDED"}
    if any(peer_id not in mandate["allowedParticipantPeerIds"] for peer_id in request.get("participantPeerIds", [])):
        return {"status": "denied", "code": "PARTICIPANT_DENIED"}
    if request["action"] not in mandate.get("allowedActions", []):
        return {"status": "denied", "code": "ACTION_DENIED"}
    tool = request.get("tool")
    if tool:
        grant = next((item for item in mandate.get("allowedTools", []) if item["tool"] == tool["tool"]), None)
        if (not grant or tool["action"] not in grant["actions"]
                or not _tool_audience_allowed(grant.get("audience"), tool.get("audience"))):
            return {"status": "denied", "code": "TOOL_DENIED"}
    for access in request.get("dataAccesses", []):
        grant = next((item for item in mandate.get("allowedData", []) if item["resource"] == access["resource"]), None)
        if not grant or access["permission"] not in grant["permissions"] or any(
            peer not in grant.get("allowedRecipientPeerIds", []) for peer in access.get("recipientPeerIds", [])
        ):
            return {"status": "denied", "code": "DATA_DENIED", "detail": access["resource"]}
    spend = request.get("spend")
    if spend:
        limits = [item for item in mandate.get("spendLimits", []) if item["currency"] == spend["currency"]]
        if not limits or any(
            (item.get("maximumPerOperationMinor") is not None
             and int(spend["amountMinor"]) > int(item["maximumPerOperationMinor"]))
            or int(request.get("spendUsedMinorByLimit", {}).get(f"{item['currency']}:{item['period']}", 0))
            + int(spend["amountMinor"]) > int(item["maximumAmountMinor"]) for item in limits
        ):
            return {"status": "denied", "code": "SPEND_LIMIT_EXCEEDED"}
    volume = mandate.get("volumeLimits")
    if volume:
        used = request.get("volumeUsed", {})
        delta = request.get("volumeDelta", {})
        for metric, maximum_key in (
            ("messages", "maxMessages"), ("files", "maxFiles"),
            ("totalBytes", "maxTotalBytes"), ("actions", "maxActions"),
        ):
            maximum = volume.get(maximum_key)
            if maximum is not None and int(used.get(metric, 0)) + int(delta.get(metric, 0)) > int(maximum):
                return {"status": "denied", "code": "VOLUME_LIMIT_EXCEEDED", "detail": metric}
        for metric, maximum in volume.get("custom", {}).items():
            if int(used.get("custom", {}).get(metric, 0)) + int(delta.get("custom", {}).get(metric, 0)) > int(maximum):
                return {"status": "denied", "code": "VOLUME_LIMIT_EXCEEDED", "detail": metric}
    missing = []
    approval_map = {item["thresholdId"]: item for item in approvals}
    for threshold in mandate.get("approvalThresholds", []):
        if not _threshold_matches(threshold, request):
            continue
        evidence = approval_map.get(threshold["id"])
        if not evidence or len(set(evidence["approverPeerIds"]) & set(threshold["approverPeerIds"])) < int(threshold["requiredApprovals"]):
            missing.append(threshold["id"])
    if missing:
        return {"status": "requires_approval", "thresholdIds": missing, "reason": "THRESHOLD"}
    return {"status": "permitted"}


def _tool_audience_allowed(allowed: str | None, requested: str | None) -> bool:
    if not allowed:
        return True
    if not requested:
        return False
    requested_host = _audience_host(requested)
    for entry in (item for item in allowed.replace(",", " ").split() if item):
        if entry == "*":
            return True
        wildcard = entry.startswith("*.")
        allowed_host = _audience_host(entry[2:] if wildcard else entry)
        if not allowed_host or not requested_host:
            if entry.lower() == requested.lower():
                return True
            continue
        if requested_host == allowed_host or (wildcard and requested_host.endswith(f".{allowed_host}")):
            return True
    return False


def _audience_host(value: str) -> str | None:
    candidate = value.strip().lower()
    if not candidate:
        return None
    parsed = urlparse(candidate if "://" in candidate else f"https://{candidate}")
    return parsed.hostname.rstrip(".") if parsed.hostname else None


def _threshold_matches(threshold: dict[str, Any], request: dict[str, Any]) -> bool:
    condition = threshold["when"]
    if condition.get("action") and condition["action"] != request["action"]:
        return False
    if condition.get("tool") and condition["tool"] != request.get("tool", {}).get("tool"):
        return False
    if "amountAboveMinor" in condition:
        spend = request.get("spend")
        if not spend or spend["currency"] != condition["currency"] or int(spend["amountMinor"]) <= int(condition["amountAboveMinor"]):
            return False
    if condition.get("dataClassification") and not any(
        item.get("classification") == condition["dataClassification"] for item in request.get("dataAccesses", [])
    ):
        return False
    return True


def _approval_operation(
    request: dict[str, Any], signed: dict[str, Any], threshold_id: str,
) -> dict[str, Any]:
    surface = _approval_surface(request)
    return {
        "operationId": str(request["operationId"]),
        "mandateId": str(signed["mandate"]["mandateId"]),
        "revision": int(signed["mandate"]["revision"]),
        "thresholdId": threshold_id,
        "action": str(request["action"]),
        **surface,
        "participantPeerIds": sorted(str(peer_id) for peer_id in request.get("participantPeerIds", [])),
        "tool": request.get("tool"),
        "dataAccesses": request.get("dataAccesses", []),
        "spend": request.get("spend"),
        "delegationDepth": int(request.get("delegationDepth", 0)),
        "principalApprovedDelegation": bool(request.get("principalApprovedDelegation", False)),
    }


def _approval_surface(request: dict[str, Any]) -> dict[str, Any]:
    target = request.get("target")
    normalized_target = None
    if target:
        normalized_target = {
            "type": str(target["type"]).strip(),
            "label": str(target["label"]).strip(),
            **({"reference": str(target["reference"]).strip()} if str(target.get("reference", "")).strip() else {}),
        }
    return {
        "rationale": str(request.get("rationale") or f"Approve {request['action']}").strip(),
        "summary": str(request.get("summary") or "").strip(),
        "target": normalized_target,
        "effect": str(request.get("effect") or "").strip(),
        "financialImpact": request.get("financialImpact"),
        "dataCategories": [str(value).strip() for value in request.get("dataCategories", [])],
    }


def _approval_request_id(request: dict[str, Any], signed: dict[str, Any], threshold_id: str) -> str:
    """Bind one consent request to the exact proposed operation."""
    return _deterministic_uuid(f"approval:{hash_canonical(_approval_operation(request, signed, threshold_id))}")


def _approval_payload_matches_request(payload: dict[str, Any], request: dict[str, Any]) -> bool:
    expected = _approval_surface(request)
    return (
        payload.get("rationale") == expected["rationale"]
        and payload.get("summary") == expected["summary"]
        and payload.get("effect") == expected["effect"]
        and hash_canonical(payload.get("target")) == hash_canonical(expected["target"])
        and hash_canonical(payload.get("financialImpact")) == hash_canonical(expected["financialImpact"])
        and payload.get("dataCategories", []) == expected["dataCategories"]
        and payload.get("relatedEventIds", []) == []
    )


def default_workroom_action(kind: str) -> str:
    """Return the stable action identifier used by app-created agent permissions."""
    if kind == "cost":
        raise ValueError("WORKROOM_COST_MUST_BE_DERIVED_FROM_AN_EXECUTED_ACTION")
    if kind == "approval_request":
        raise ValueError("WORKROOM_APPROVAL_REQUESTS_ARE_CREATED_BY_THE_MANDATE_GUARD")
    actions = {
        "message": "message.send", "activity": "message.send",
        "artifact_version": "file.create", "deliverable": "deliverable.submit",
        "plan": "plan.update",
    }
    if kind not in actions:
        raise ValueError("WORKROOM_EVENT_KIND_INVALID")
    return actions[kind]


def _workroom_stop_reason(workroom: dict[str, Any], now: datetime | None = None) -> str | None:
    status = str(workroom.get("status", "executing"))
    if status in {"completed", "cancelled", "expired"}:
        return status
    deadline = workroom.get("deadline")
    if deadline and (now or datetime.now(timezone.utc)) >= _instant(str(deadline)):
        return "deadline"
    return None


def _validate_descriptor(value: Any) -> None:
    if not isinstance(value, dict) or set(value) - {"version", "title", "objective", "deadline"}:
        raise ValueError("INVALID_WORKROOM_DESCRIPTOR")
    if value.get("version") != 1 or not isinstance(value.get("objective"), str) or not value["objective"].strip():
        raise ValueError("INVALID_WORKROOM_DESCRIPTOR")
    if len(value["objective"]) > 4_000 or ("title" in value and (not str(value["title"]).strip() or len(value["title"]) > 160)):
        raise ValueError("INVALID_WORKROOM_DESCRIPTOR")
    if value.get("deadline") is not None:
        _instant(str(value["deadline"]))


def _validate_payload(value: Any, thread_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("kind") not in (
        "message", "activity", "plan", "artifact_version", "deliverable", "cost", "approval_request",
    ):
        raise ValueError("INVALID_WORKROOM_PAYLOAD")
    content = json.loads(json.dumps(value))
    kind = content["kind"]
    if kind in {"message", "activity"} and content.get("threadId") != thread_id:
        raise ValueError("WORKROOM_THREAD_MISMATCH")
    if kind == "message":
        _required_text(content, "body", 200_000)
        _validate_mentions(content.get("mentions", []))
    elif kind == "activity":
        _required_identifier(content, "activityType")
        _required_text(content, "summary", 4_000)
        _validate_mentions(content.get("mentions", []))
    elif kind == "plan":
        if not isinstance(content.get("planVersion"), int) or content["planVersion"] < 1:
            raise ValueError("INVALID_WORKROOM_PLAN")
        _required_text(content, "summary", 2_000)
        steps = content.get("steps")
        if not isinstance(steps, list) or not steps or len(steps) > 500:
            raise ValueError("INVALID_WORKROOM_PLAN")
        identifiers = set()
        for step in steps:
            if not isinstance(step, dict):
                raise ValueError("INVALID_WORKROOM_PLAN")
            identifier = _required_identifier(step, "id")
            if identifier in identifiers:
                raise ValueError("INVALID_WORKROOM_PLAN")
            identifiers.add(identifier)
            _required_text(step, "title", 500)
            if step.get("status") not in {
                "executing", "waiting_approval", "blocked", "completed", "cancelled", "expired",
            }:
                raise ValueError("INVALID_WORKROOM_PLAN")
            _validate_uuid_list(step.get("assignedPeerIds", []), 100)
        if any(dependency not in identifiers or dependency == step["id"] for step in steps for dependency in step.get("dependsOnStepIds", [])):
            raise ValueError("INVALID_WORKROOM_PLAN")
    elif kind == "artifact_version":
        _required_uuid(content, "artifactId")
        if not isinstance(content.get("artifactVersion"), int) or content["artifactVersion"] < 1:
            raise ValueError("INVALID_WORKROOM_ARTIFACT")
        _required_identifier(content, "artifactType")
        _required_text(content, "title", 500)
        _required_text(content, "contentHash", 4_096)
        attachment_ids = _validate_uuid_list(content.get("attachmentIds", []), 100)
        descriptors = content.get("attachments")
        if descriptors is not None:
            if not isinstance(descriptors, list) or [item.get("id") for item in descriptors if isinstance(item, dict)] != attachment_ids:
                raise ValueError("WORKROOM_ATTACHMENT_DESCRIPTOR_MISMATCH")
        _validate_mentions(content.get("mentions", []))
    elif kind == "deliverable":
        _required_uuid(content, "artifactId")
        if not isinstance(content.get("artifactVersion"), int) or content["artifactVersion"] < 1:
            raise ValueError("INVALID_WORKROOM_DELIVERABLE")
        if content.get("artifactVersionId") is not None:
            _required_uuid(content, "artifactVersionId")
        criteria = content.get("acceptanceCriteria")
        if not isinstance(criteria, list) or not criteria or len(criteria) > 100 or any(
            not isinstance(item, str) or not item.strip() or len(item) > 1_000 for item in criteria
        ):
            raise ValueError("INVALID_WORKROOM_DELIVERABLE")
        _validate_mentions(content.get("mentions", []))
    elif kind == "approval_request":
        _required_identifier(content, "action")
        _required_text(content, "rationale", 4_000)
        eligible = _validate_uuid_list(content.get("requestedApproverPeerIds", []), 100)
        required = content.get("requiredApprovals")
        if not isinstance(required, int) or required < 1 or required > len(set(eligible)):
            raise ValueError("INVALID_APPROVAL_THRESHOLD")
    elif kind == "cost":
        if content.get("metric") not in {"money", "tokens", "duration_ms", "custom"}:
            raise ValueError("INVALID_WORKROOM_COST")
    return content


def _required_text(value: dict[str, Any], key: str, maximum: int) -> str:
    result = value.get(key)
    if not isinstance(result, str) or not result.strip() or len(result) > maximum:
        raise ValueError(f"INVALID_{key.upper()}")
    return result


def _required_identifier(value: dict[str, Any], key: str) -> str:
    import re
    result = _required_text(value, key, 200)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]*", result):
        raise ValueError(f"INVALID_{key.upper()}")
    return result


def _required_uuid(value: dict[str, Any], key: str) -> str:
    result = _required_text(value, key, 64)
    try:
        uuid.UUID(result)
    except (ValueError, AttributeError) as error:
        raise ValueError(f"INVALID_{key.upper()}") from error
    return result


def _validate_uuid_list(value: Any, maximum: int) -> list[str]:
    if not isinstance(value, list) or len(value) > maximum:
        raise ValueError("INVALID_UUID_LIST")
    for item in value:
        try:
            uuid.UUID(str(item))
        except (ValueError, AttributeError) as error:
            raise ValueError("INVALID_UUID_LIST") from error
    return [str(item) for item in value]


def _validate_mentions(value: Any) -> None:
    import re
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("INVALID_WORKROOM_MENTIONS")
    for mention in value:
        if not isinstance(mention, dict):
            raise ValueError("INVALID_WORKROOM_MENTIONS")
        _required_uuid(mention, "peerId")
        if mention.get("peerType") not in {"HUMAN", "AGENT"} or mention.get("intent", "direct") not in {
            "direct", "fyi", "approval_requested",
        } or not re.fullmatch(r"@[a-z0-9][a-z0-9._-]{1,62}", str(mention.get("handle", ""))):
            raise ValueError("INVALID_WORKROOM_MENTIONS")


def _event_membership_snapshot(record: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Validate a historical identity view against the signed recipient ids."""
    import re
    raw = record.get("membershipSnapshot")
    if raw is None:
        return None
    if not isinstance(raw, list) or not 1 <= len(raw) <= 1_000:
        raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_INVALID")
    snapshot: list[dict[str, Any]] = []
    peer_ids: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_INVALID")
        try:
            peer_id = str(uuid.UUID(str(item.get("peerId", ""))))
        except (ValueError, AttributeError) as error:
            raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_INVALID") from error
        signing_key = item.get("signingPublicKey")
        encryption_key = item.get("encryptionPublicKey")
        if (
            item.get("peerType") not in {"HUMAN", "AGENT"}
            or item.get("role") not in {"owner", "supervisor", "contributor", "observer"}
            or not re.fullmatch(r"@[a-z0-9][a-z0-9._-]{1,62}", str(item.get("handle", "")))
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", str(signing_key or ""))
            or not re.fullmatch(r"[A-Za-z0-9_-]{1,4096}", str(encryption_key or ""))
        ):
            raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_INVALID")
        peer_ids.append(peer_id)
        snapshot.append({**item, "peerId": peer_id})
    actor_peer_id = str(record.get("event", {}).get("actorPeerId", ""))
    if len(set(peer_ids)) != len(peer_ids) or actor_peer_id not in peer_ids:
        raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_INVALID")
    envelope = record.get("event", {}).get("envelope", {})
    if envelope.get("cipherSuite") == "ATALK_GROUP_BOX_V1":
        wrapped_keys = envelope.get("wrappedKeys", [])
        recipients = [str(item.get("recipientPeerId", "")) for item in wrapped_keys]
        if len(set(recipients)) != len(recipients) or set(recipients) != set(peer_ids):
            raise ValueError("WORKROOM_EVENT_MEMBERSHIP_SNAPSHOT_MISMATCH")
        members = {item["peerId"]: item for item in snapshot}
        hashes = [wrapped.get("recipientEncryptionKeyHash") for wrapped in wrapped_keys]
        if not all(value is None for value in hashes) and any(
            not members.get(str(wrapped.get("recipientPeerId", "")), {}).get("encryptionPublicKey")
            or wrapped.get("recipientEncryptionKeyHash") != hash_b64url_payload(
                members[str(wrapped.get("recipientPeerId", ""))]["encryptionPublicKey"],
            )
            for wrapped in wrapped_keys
        ):
            raise ValueError("WORKROOM_EVENT_RECIPIENT_KEY_MISMATCH")
    return snapshot


def _is_legacy_audit_only_event(record: dict[str, Any]) -> bool:
    if record.get("membershipSnapshot") is None:
        return True
    envelope = record.get("event", {}).get("envelope", {})
    return envelope.get("cipherSuite") == "ATALK_GROUP_BOX_V1" and all(
        item.get("recipientEncryptionKeyHash") is None
        for item in envelope.get("wrappedKeys", [])
        if isinstance(item, dict)
    )


def _snapshot_routing_detail(snapshot: list[dict[str, Any]]) -> dict[str, Any]:
    return {"members": [{
        "membership": {
            "peerId": item["peerId"],
            "peerType": item["peerType"],
            "role": item["role"],
        },
        "peer": {
            "id": item["peerId"],
            "type": item["peerType"],
            "status": "ACTIVE",
            "handle": item["handle"],
        },
    } for item in snapshot]}


def _peer_from_event_snapshot(
    snapshot: dict[str, Any], current: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        **(current or {
            "displayName": str(snapshot["handle"])[1:],
            "publicDiscoverable": False,
            "organizationDiscoverable": False,
        }),
        "id": snapshot["peerId"],
        "type": snapshot["peerType"],
        "status": "ACTIVE",
        "handle": snapshot["handle"],
        "signingPublicKey": snapshot["signingPublicKey"],
        "encryptionPublicKey": snapshot["encryptionPublicKey"],
    }


def _active_routing_peers(detail: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Return canonical, currently active Task identities keyed by peer id."""
    peers: dict[str, dict[str, Any]] = {}
    for item in detail.get("members", []):
        membership = item.get("membership") if isinstance(item, dict) else None
        if not isinstance(membership, dict) or membership.get("leftAt"):
            continue
        peer = item.get("peer")
        if not isinstance(peer, dict) or peer.get("status") != "ACTIVE":
            continue
        peer_id = str(membership.get("peerId", ""))
        peer_type = peer.get("type")
        if (
            not peer_id
            or str(peer.get("id", "")) != peer_id
            or peer_type not in {"HUMAN", "AGENT"}
            or membership.get("peerType") != peer_type
            or peer_id in peers
        ):
            raise ValueError("WORKROOM_ROUTING_MEMBER_INVALID")
        peers[peer_id] = {"peer": peer, "role": membership.get("role")}
    return peers


def _validate_routing_bindings(
    content: dict[str, Any], detail: dict[str, Any], actor_peer_id: str,
    *, allow_observer_targets: bool = False,
) -> None:
    """Bind every encrypted routing target to one exact active Task identity.

    The relay cannot validate encrypted mentions. Publishers and recipients both
    run this check, so a stale, forged or identity-confused target fails closed.
    """
    peers = _active_routing_peers(detail)
    seen_mentions: set[str] = set()
    for mention in content.get("mentions", []):
        peer_id = str(mention["peerId"])
        if peer_id in seen_mentions:
            raise ValueError("WORKROOM_ROUTING_DUPLICATE_TARGET")
        seen_mentions.add(peer_id)
        binding = peers.get(peer_id)
        if binding is None:
            raise ValueError("WORKROOM_ROUTING_TARGET_NOT_ACTIVE")
        peer = binding["peer"]
        expected_type = peer.get("type")
        if expected_type not in {"AGENT", "HUMAN"}:
            raise ValueError("WORKROOM_ROUTING_MEMBER_INVALID")
        if mention.get("handle") != peer.get("handle") or mention.get("peerType") != expected_type:
            raise ValueError("WORKROOM_ROUTING_IDENTITY_MISMATCH")
        if mention.get("intent", "direct") == "direct" and peer_id == actor_peer_id:
            raise ValueError("WORKROOM_SELF_DIRECTION_FORBIDDEN")
        if (mention.get("intent", "direct") == "direct"
                and binding.get("role") == "observer" and not allow_observer_targets):
            raise ValueError("WORKROOM_ROUTING_TARGET_NOT_EXECUTABLE")

    if content.get("kind") != "plan":
        return
    for step in content.get("steps", []):
        assigned = [str(peer_id) for peer_id in step.get("assignedPeerIds", [])]
        if len(assigned) != len(set(assigned)):
            raise ValueError("WORKROOM_ROUTING_DUPLICATE_TARGET")
        if any(peer_id not in peers for peer_id in assigned):
            raise ValueError("WORKROOM_ROUTING_TARGET_NOT_ACTIVE")
        if (not allow_observer_targets
                and any(peers[peer_id].get("role") == "observer" for peer_id in assigned)):
            raise ValueError("WORKROOM_ROUTING_TARGET_NOT_EXECUTABLE")


def _active_peer_ids(detail: dict[str, Any]) -> list[str]:
    return sorted(str(item["membership"]["peerId"]) for item in detail.get("members", []) if not item["membership"].get("leftAt"))


def _payload_volume(content: dict[str, Any]) -> dict[str, Any]:
    if content["kind"] == "artifact_version":
        descriptors = content.get("attachments") or []
        return {
            "messages": 0, "files": len(content.get("attachmentIds", [])),
            "totalBytes": sum(int(item.get("size", 0)) for item in descriptors),
            "actions": 1, "custom": {},
        }
    return {
        "messages": 1 if content["kind"] in {"message", "activity"} else 0,
        "files": 0,
        "totalBytes": len(json.dumps(content, ensure_ascii=False, separators=(",", ":")).encode()),
        "actions": 1, "custom": {},
    }


def _publication_summary(content: dict[str, Any]) -> str:
    kind = content["kind"]
    return {
        "message": "Send a message in this Task", "activity": content.get("summary"),
        "plan": content.get("summary"), "artifact_version": f"Add file: {content.get('title')}",
        "deliverable": "Submit a deliverable for review", "cost": "Record Task usage",
        "approval_request": content.get("summary") or content.get("rationale"),
    }[kind]


def _publication_effect(content: dict[str, Any]) -> str:
    return {
        "message": "Share the message with every current Task participant",
        "activity": "Share this progress update with every current Task participant",
        "plan": "Replace the visible Task plan with this signed version",
        "artifact_version": "Share the encrypted file version with every current Task participant",
        "deliverable": "Mark the selected artifact version as a deliverable awaiting review",
        "cost": "Append this usage record to the Task",
        "approval_request": content.get("effect") or "Ask the selected people to approve this operation",
    }[content["kind"]]


def _routing_context(
    content: dict[str, Any], recipient_peer_id: str, actor_peer_id: str | None = None,
    recipient_role: str | None = None,
) -> dict[str, Any]:
    """Return only the routing slice executable by one recipient."""
    if (actor_peer_id is not None and recipient_peer_id == actor_peer_id) or recipient_role == "observer":
        return {"directedToMe": False, "directMentions": [], "assignedSteps": []}
    direct_mentions = [
        dict(item)
        for item in content.get("mentions", [])
        if item.get("peerId") == recipient_peer_id and item.get("intent", "direct") == "direct"
    ]
    assigned_steps = []
    if content.get("kind") == "plan":
        assigned_steps = [
            json.loads(json.dumps(step))
            for step in content.get("steps", [])
            if step.get("status") == "executing"
            and recipient_peer_id in step.get("assignedPeerIds", [])
        ]
    return {
        "directedToMe": bool(direct_mentions or assigned_steps),
        "directMentions": direct_mentions,
        "assignedSteps": assigned_steps,
    }


def _content_directed_to(
    content: dict[str, Any], peer_id: str, actor_peer_id: str | None = None,
) -> bool:
    """Compatibility helper; autonomous consumers should use ``routing``."""
    return bool(_routing_context(content, peer_id, actor_peer_id)["directedToMe"])


def _autonomous_event_view(event: dict[str, Any]) -> dict[str, Any]:
    """Hide other participants' plan steps from an autonomous handler."""
    content = event.get("content")
    if not isinstance(content, dict) or content.get("kind") != "plan":
        return event
    routing = event.get("routing")
    assigned_steps = routing.get("assignedSteps", []) if isinstance(routing, dict) else []
    return {
        **event,
        "content": {
            **content,
            "steps": json.loads(json.dumps(assigned_steps)),
        },
    }


def _mandate_usage_key(signed: dict[str, Any]) -> str:
    mandate = signed["mandate"]
    return f"{mandate['mandateId']}:{mandate['revision']}"


def _empty_volume() -> dict[str, Any]:
    return {"messages": 0, "files": 0, "totalBytes": 0, "actions": 0, "custom": {}}


def _normalize_volume(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    custom = source.get("custom") if isinstance(source.get("custom"), dict) else {}
    return {
        "messages": int(source.get("messages", 0)), "files": int(source.get("files", 0)),
        "totalBytes": int(source.get("totalBytes", 0)), "actions": int(source.get("actions", 0)),
        "custom": {str(key): int(amount) for key, amount in custom.items()},
    }


def _maximum_volume(left: Any, right: Any) -> dict[str, Any]:
    first, second = _normalize_volume(left), _normalize_volume(right)
    custom_keys = set(first["custom"]) | set(second["custom"])
    return {
        "messages": max(first["messages"], second["messages"]),
        "files": max(first["files"], second["files"]),
        "totalBytes": max(first["totalBytes"], second["totalBytes"]),
        "actions": max(first["actions"], second["actions"]),
        "custom": {key: max(first["custom"].get(key, 0), second["custom"].get(key, 0)) for key in custom_keys},
    }


def _add_volume(left: Any, right: Any) -> dict[str, Any]:
    first, second = _normalize_volume(left), _normalize_volume(right)
    custom_keys = set(first["custom"]) | set(second["custom"])
    return {
        "messages": _safe_add(first["messages"], second["messages"]),
        "files": _safe_add(first["files"], second["files"]),
        "totalBytes": _safe_add(first["totalBytes"], second["totalBytes"]),
        "actions": _safe_add(first["actions"], second["actions"]),
        "custom": {key: _safe_add(first["custom"].get(key, 0), second["custom"].get(key, 0)) for key in custom_keys},
    }


def _maximum_counters(left: Any, right: dict[str, int]) -> dict[str, int]:
    first = left if isinstance(left, dict) else {}
    keys = set(first) | set(right)
    return {str(key): max(int(first.get(key, 0)), int(right.get(key, 0))) for key in keys}


def _safe_add(left: int, right: int) -> int:
    result = left + right
    if result < 0 or result > 9_007_199_254_740_991:
        raise ValueError("MANDATE_USAGE_OVERFLOW")
    return result


def _spend_bucket(period: str, now: datetime) -> str:
    if period == "mandate":
        return "mandate"
    if period == "month":
        return now.strftime("%Y-%m")
    if period == "day":
        return now.strftime("%Y-%m-%d")
    monday = now.date()
    monday = monday.fromordinal(monday.toordinal() - monday.weekday())
    return monday.isoformat()


def _prepare_payload_projection(payload: dict[str, Any], projection: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any] | None]:
    content = json.loads(json.dumps(payload))
    kind = content.get("kind")
    if kind not in _TYPED_KINDS:
        if projection:
            raise ValueError("WORKROOM_PROJECTION_UNEXPECTED")
        return content, None
    if projection and projection.get("kind") != kind:
        raise ValueError("PROJECTION_KIND_MISMATCH")
    if kind == "plan":
        identifier = (projection or {}).get("id") or content.get("planId") or str(uuid.uuid4())
        content["planId"] = identifier
        return content, {"kind": kind, "id": identifier, "version": content["planVersion"]}
    if kind == "artifact_version":
        identifier = (projection or {}).get("id") or content.get("artifactVersionId") or str(uuid.uuid4())
        content["artifactVersionId"] = identifier
        return content, {"kind": kind, "id": identifier, "artifactId": content["artifactId"], "artifactVersion": content["artifactVersion"], "attachmentIds": content.get("attachmentIds", [])}
    if kind == "deliverable":
        identifier = (projection or {}).get("id") or content.get("deliverableId") or str(uuid.uuid4())
        version_id = (projection or {}).get("artifactVersionId") or content.get("artifactVersionId")
        if not version_id:
            raise ValueError("DELIVERABLE_ARTIFACT_VERSION_ID_REQUIRED")
        content.update({"deliverableId": identifier, "artifactVersionId": version_id})
        return content, {"kind": kind, "id": identifier, "artifactId": content["artifactId"], "artifactVersionId": version_id}
    if kind == "cost":
        identifier = (projection or {}).get("id") or content.get("costId") or str(uuid.uuid4())
        content["costId"] = identifier
        return content, {"kind": kind, "id": identifier}
    identifier = (projection or {}).get("id") or content.get("requestId") or str(uuid.uuid4())
    content["requestId"] = identifier
    result = {"kind": kind, "id": identifier, "requiredApprovals": content["requiredApprovals"], "eligiblePeerIds": content["requestedApproverPeerIds"]}
    if content.get("expiresAt"):
        result["expiresAt"] = content["expiresAt"]
    return content, result


def _validate_projection(projection: dict[str, Any] | None, content: dict[str, Any]) -> None:
    kind = content.get("kind")
    if kind not in _TYPED_KINDS:
        if projection:
            raise ValueError("WORKROOM_PROJECTION_UNEXPECTED")
        return
    if not projection or projection.get("kind") != kind:
        raise ValueError("WORKROOM_PROJECTION_MISSING")
    critical: dict[str, tuple[Any, Any]] = {
        "plan": (content.get("planId"), projection.get("id")),
        "artifact_version": (
            (content.get("artifactVersionId"), content.get("artifactId"), content.get("artifactVersion"), content.get("attachmentIds", [])),
            (projection.get("id"), projection.get("artifactId"), projection.get("artifactVersion"), projection.get("attachmentIds", [])),
        ),
        "deliverable": (
            (content.get("deliverableId"), content.get("artifactId"), content.get("artifactVersionId")),
            (projection.get("id"), projection.get("artifactId"), projection.get("artifactVersionId")),
        ),
        "cost": (content.get("costId"), projection.get("id")),
        "approval_request": (
            (content.get("requestId"), content.get("requiredApprovals"), set(content.get("requestedApproverPeerIds", [])), content.get("expiresAt")),
            (projection.get("id"), projection.get("requiredApprovals"), set(projection.get("eligiblePeerIds", [])), projection.get("expiresAt")),
        ),
    }
    if critical[kind][0] != critical[kind][1]:
        raise ValueError("WORKROOM_PROJECTION_MISMATCH")
    if kind == "artifact_version":
        descriptors = content.get("attachments")
        if descriptors is not None and [item.get("id") for item in descriptors] != content.get("attachmentIds", []):
            raise ValueError("WORKROOM_ATTACHMENT_DESCRIPTOR_MISMATCH")


def _exact_recipients(detail: dict[str, Any]) -> list[dict[str, str]]:
    result = []
    for item in detail["members"]:
        if item["membership"].get("leftAt"):
            continue
        peer = item.get("peer")
        if not peer or peer.get("status") != "ACTIVE":
            raise ValueError("WORKROOM_MEMBER_KEY_MISSING")
        result.append({"peerId": peer["id"], "encryptionPublicKey": peer["encryptionPublicKey"]})
    if len({item["peerId"] for item in result}) != len(result):
        raise ValueError("WORKROOM_MEMBER_DUPLICATE")
    return sorted(result, key=lambda item: item["peerId"])


def _peer(detail: dict[str, Any], peer_id: str) -> dict[str, Any] | None:
    return next((item.get("peer") for item in detail["members"] if item["membership"]["peerId"] == peer_id), None)


def _required_peer(detail: dict[str, Any], peer_id: str) -> dict[str, Any]:
    peer = _peer(detail, peer_id)
    if not peer:
        raise ValueError("WORKROOM_MEMBER_KEY_MISSING")
    return peer


def _deterministic_uuid(value: str) -> str:
    digest = bytearray(hashlib.sha256(value.encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _hash_file(path: Path) -> str:
    import base64
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return base64.urlsafe_b64encode(digest.digest()).rstrip(b"=").decode()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _raise_cancelled(cancel: asyncio.Event | None) -> None:
    if cancel and cancel.is_set():
        raise asyncio.CancelledError("Workroom operation was cancelled")


def _mime_type(path: Path) -> str:
    import mimetypes
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _is_purchase_action(action: str) -> bool:
    import re
    return bool(re.search(r"(?:^|[._:/-])(purchase|payment|pay|spend)(?:$|[._:/-])", action, re.IGNORECASE))
