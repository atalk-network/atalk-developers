"""Hermes-native tools for governed aTalk Tasks/Workrooms."""

from __future__ import annotations

import json
import mimetypes
import os
import uuid
from pathlib import Path
from typing import Any


MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
_active_adapter: Any | None = None


def set_active_adapter(adapter: Any) -> None:
    global _active_adapter
    _active_adapter = adapter


def clear_active_adapter(adapter: Any) -> None:
    global _active_adapter
    if _active_adapter is adapter:
        _active_adapter = None


def _adapter() -> Any:
    if _active_adapter is None:
        raise RuntimeError("The aTalk Hermes platform is not connected")
    return _active_adapter


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _task_view(detail: dict[str, Any]) -> dict[str, Any]:
    workroom = detail["workroom"]
    return {
        "id": workroom["id"],
        "status": workroom["status"],
        "deadline": workroom.get("deadline"),
        "descriptor": detail["descriptor"],
        "membership": {
            "role": detail["membership"]["role"],
            "joinedAt": detail["membership"]["joinedAt"],
            "leftAt": detail["membership"].get("leftAt"),
        },
        "members": [{
            "id": item["membership"]["peerId"],
            "role": item["membership"]["role"],
            "leftAt": item["membership"].get("leftAt"),
            "handle": item.get("peer", {}).get("handle") if item.get("peer") else None,
            "displayName": item.get("peer", {}).get("displayName") if item.get("peer") else None,
            "type": item.get("peer", {}).get("type") if item.get("peer") else None,
        } for item in detail.get("members", [])],
        "threads": [{"id": item["id"], "kind": item["kind"], "createdAt": item["createdAt"]}
                    for item in detail.get("threads", [])],
        "permissions": [{
            "mandateId": item["mandate"]["mandateId"],
            "revision": item["mandate"]["revision"],
            "actorPeerId": item["mandate"]["actorPeerId"],
            "validFrom": item["mandate"]["validFrom"],
            "validUntil": item["mandate"]["validUntil"],
            "revoked": bool(item.get("revocation")),
        } for item in detail.get("latestMandates", [])],
        "approvals": [{
            "requestId": item["requestId"], "status": item["status"],
            "requiredApprovals": item["requiredApprovals"],
            "eligiblePeerIds": item["eligiblePeerIds"], "expiresAt": item.get("expiresAt"),
        } for item in detail.get("approvals", [])],
    }


def _participants(detail: dict[str, Any]) -> list[str]:
    return [str(item["membership"]["peerId"]) for item in detail.get("members", [])
            if not item["membership"].get("leftAt")]


def _peers(detail: dict[str, Any], handles: list[str]) -> list[dict[str, Any]]:
    active = [item["peer"] for item in detail.get("members", [])
              if not item["membership"].get("leftAt") and item.get("peer")]
    peers = []
    for handle in handles:
        peer = next((candidate for candidate in active if candidate.get("handle") == handle), None)
        if peer is None:
            raise ValueError(f"Active Task participant not found: {handle}")
        peers.append(peer)
    return peers


def _mentions(detail: dict[str, Any], handles: list[str]) -> list[dict[str, str]]:
    return [{
        "peerId": str(peer["id"]), "handle": str(peer["handle"]),
        "peerType": "AGENT" if peer.get("type") == "AGENT" else "HUMAN", "intent": "direct",
    } for peer in _peers(detail, handles)]


def _prepare_payload(detail: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
    kind = str(params["kind"])
    if kind == "message":
        return {
            "version": 1, "kind": kind, "threadId": params["threadId"], "body": params["body"],
            "mentions": _mentions(detail, params.get("mentionHandles", [])),
            **({"replyToEventId": params["replyToEventId"]} if params.get("replyToEventId") else {}),
        }
    if kind == "activity":
        return {
            "version": 1, "kind": kind, "threadId": params["threadId"],
            "activityType": params["activityType"], "summary": params["summary"],
            "mentions": _mentions(detail, params.get("mentionHandles", [])),
            "sourceEventIds": params.get("sourceEventIds", []), "attributes": params.get("attributes", {}),
        }
    if kind == "plan":
        return {
            "version": 1, "kind": kind, "planVersion": params["planVersion"], "summary": params["summary"],
            **({"planId": params["planId"]} if params.get("planId") else {}),
            "steps": [{
                "id": step["id"], "title": step["title"], "status": step["status"],
                "assignedPeerIds": [str(peer["id"]) for peer in _peers(detail, step.get("assignedHandles", []))],
                "dependsOnStepIds": step.get("dependsOnStepIds", []),
                **({"deadline": step["deadline"]} if step.get("deadline") else {}),
            } for step in params["steps"]],
        }
    if kind == "deliverable":
        return {
            "version": 1, "kind": kind, "artifactId": params["artifactId"],
            "artifactVersion": params["artifactVersion"],
            **({"artifactVersionId": params["artifactVersionId"]} if params.get("artifactVersionId") else {}),
            **({"deliverableId": params["deliverableId"]} if params.get("deliverableId") else {}),
            "acceptanceCriteria": params["acceptanceCriteria"],
            **({"note": params["note"]} if params.get("note") else {}),
            "mentions": _mentions(detail, params.get("mentionHandles", [])),
        }
    raise ValueError(f"Unsupported aTalk Task publication: {kind}")


async def _list(params: dict[str, Any], **_kwargs: Any) -> str:
    page = await _adapter()._agent.workrooms.list(params.get("cursor"), int(params.get("limit", 50)))
    return _json({"tasks": [_task_view(item) for item in page.get("workrooms", [])],
                  "nextCursor": page.get("nextCursor")})


async def _open(params: dict[str, Any], **_kwargs: Any) -> str:
    detail = await _adapter()._agent.workrooms.get(str(params["workroomId"]), 0, 1)
    return _json(_task_view(detail))


async def _publish(params: dict[str, Any], **_kwargs: Any) -> str:
    adapter = _adapter()
    detail = await adapter._agent.workrooms.get(str(params["workroomId"]), 0, 1)
    operation_id = str(params.get("operationId") or uuid.uuid4())
    result = await adapter._agent.workrooms.publish_mandated({
        "workroomId": params["workroomId"], "threadId": params["threadId"],
        "operationId": operation_id, "payload": _prepare_payload(detail, params),
        "participantPeerIds": _participants(detail),
        **({"mandateId": params["mandateId"]} if params.get("mandateId") else {}),
        **({"rationale": params["rationale"]} if params.get("rationale") else {}),
    })
    return _json({"operationId": operation_id, "result": result})


def _workspace_file(value: str, kwargs: dict[str, Any]) -> Path:
    hinted = next((kwargs.get(key) for key in ("cwd", "workspace_dir", "working_dir")
                   if isinstance(kwargs.get(key), str) and kwargs.get(key)), None)
    root = Path(hinted or os.getenv("TERMINAL_CWD") or Path.cwd()).expanduser().resolve()
    candidate = Path(value).expanduser()
    path = (candidate if candidate.is_absolute() else root / candidate).resolve(strict=True)
    try:
        path.relative_to(root)
    except ValueError as error:
        raise ValueError("Task files must stay inside the active Hermes workspace") from error
    if not path.is_file():
        raise ValueError("Task attachment path is not a regular file")
    if path.stat().st_size > MAX_ATTACHMENT_BYTES:
        raise ValueError("aTalk Task attachments cannot exceed 100 MB")
    return path


async def _submit_file(params: dict[str, Any], **kwargs: Any) -> str:
    adapter = _adapter()
    detail = await adapter._agent.workrooms.get(str(params["workroomId"]), 0, 1)
    operation_id = str(params.get("operationId") or uuid.uuid4())
    path = _workspace_file(str(params["filePath"]), kwargs)
    result = await adapter._agent.workrooms.submit_file_mandated({
        "workroomId": params["workroomId"], "threadId": params["threadId"],
        "operationId": operation_id, "filePath": path,
        "name": params.get("name") or path.name,
        "mimeType": params.get("mimeType") or mimetypes.guess_type(path.name)[0] or "application/octet-stream",
        "mentions": _mentions(detail, params.get("mentionHandles", [])),
        "participantPeerIds": _participants(detail),
        **{key: params[key] for key in ("mandateId", "rationale", "title", "description", "artifactType",
                                        "artifactId", "artifactVersion") if params.get(key)},
    })
    return _json({"operationId": operation_id, "result": result})


def _schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "name": name, "description": description,
        "parameters": {"type": "object", "properties": properties, "required": required,
                       "additionalProperties": False},
    }


_UUID = {"type": "string", "format": "uuid"}
_HANDLE_LIST = {"type": "array", "items": {"type": "string", "pattern": "^@[a-z0-9][a-z0-9._-]{1,62}$"},
                "maxItems": 100}
_COMMON = {
    "workroomId": _UUID, "threadId": _UUID, "operationId": _UUID, "mandateId": _UUID,
    "rationale": {"type": "string", "maxLength": 4000},
}


def register_tools(ctx: Any) -> None:
    definitions = [
        ("atalk_task_list", _schema("atalk_task_list", "List encrypted aTalk Tasks assigned to this agent.",
                                    {"cursor": {"type": "string"}, "limit": {"type": "integer", "minimum": 1,
                                                                                 "maximum": 200}}, []), _list),
        ("atalk_task_open", _schema("atalk_task_open", "Open a verified, locally decrypted aTalk Task.",
                                    {"workroomId": _UUID}, ["workroomId"]), _open),
        ("atalk_task_message", _schema("atalk_task_message", "Publish an encrypted Task message and optionally direct it by @handle.", {
            **_COMMON, "kind": {"const": "message"}, "body": {"type": "string", "maxLength": 200000},
            "mentionHandles": _HANDLE_LIST, "replyToEventId": _UUID,
        }, ["workroomId", "threadId", "kind", "body"]), _publish),
        ("atalk_task_activity", _schema("atalk_task_activity", "Publish encrypted progress under the agent's current permission.", {
            **_COMMON, "kind": {"const": "activity"}, "activityType": {"type": "string", "maxLength": 160},
            "summary": {"type": "string", "maxLength": 4000}, "mentionHandles": _HANDLE_LIST,
        }, ["workroomId", "threadId", "kind", "activityType", "summary"]), _publish),
        ("atalk_task_plan", _schema("atalk_task_plan", "Publish a versioned Task plan. This requires plan.update permission.", {
            **_COMMON, "kind": {"const": "plan"}, "planId": _UUID,
            "planVersion": {"type": "integer", "minimum": 1}, "summary": {"type": "string", "maxLength": 2000},
            "steps": {"type": "array", "minItems": 1, "maxItems": 500, "items": {"type": "object", "properties": {
                "id": {"type": "string"}, "title": {"type": "string", "maxLength": 500},
                "status": {"type": "string", "enum": ["executing", "waiting_approval", "blocked", "completed", "cancelled", "expired"]},
                "assignedHandles": _HANDLE_LIST, "dependsOnStepIds": {"type": "array", "items": {"type": "string"}, "maxItems": 100},
                "deadline": {"type": "string", "format": "date-time"},
            }, "required": ["id", "title", "status"], "additionalProperties": False}},
        }, ["workroomId", "threadId", "kind", "planVersion", "summary", "steps"]), _publish),
        ("atalk_task_deliverable", _schema("atalk_task_deliverable", "Submit an encrypted artifact version for human review.", {
            **_COMMON, "kind": {"const": "deliverable"}, "artifactId": _UUID,
            "artifactVersion": {"type": "integer", "minimum": 1}, "artifactVersionId": _UUID,
            "deliverableId": _UUID, "acceptanceCriteria": {"type": "array", "minItems": 1, "maxItems": 100,
                                                              "items": {"type": "string", "maxLength": 1000}},
            "note": {"type": "string", "maxLength": 4000}, "mentionHandles": _HANDLE_LIST,
        }, ["workroomId", "threadId", "kind", "artifactId", "artifactVersion", "artifactVersionId", "acceptanceCriteria"]), _publish),
        ("atalk_task_submit_file", _schema("atalk_task_submit_file", "Encrypt and attach a file from the active Hermes workspace to a Task.", {
            **_COMMON, "filePath": {"type": "string"}, "name": {"type": "string", "maxLength": 500},
            "mimeType": {"type": "string", "maxLength": 200}, "title": {"type": "string", "maxLength": 500},
            "description": {"type": "string", "maxLength": 4000}, "artifactType": {"type": "string", "maxLength": 160},
            "artifactId": _UUID, "artifactVersion": {"type": "integer", "minimum": 1}, "mentionHandles": _HANDLE_LIST,
        }, ["workroomId", "threadId", "filePath"]), _submit_file),
    ]
    for name, schema, handler in definitions:
        ctx.register_tool(name=name, toolset="atalk", schema=schema, handler=handler, is_async=True,
                          description=schema["description"], emoji="🔐")
