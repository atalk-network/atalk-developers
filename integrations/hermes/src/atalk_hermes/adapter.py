from __future__ import annotations

import logging
import mimetypes
import os
import time
import asyncio
import hashlib
from pathlib import Path
from typing import Any

from atalk import Agent, Message
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult


logger = logging.getLogger(__name__)
MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
MEDIA_TTL_SECONDS = 24 * 60 * 60


def _message_type(mime_type: str) -> MessageType:
    if mime_type.startswith("image/"):
        return MessageType.PHOTO
    if mime_type.startswith("video/"):
        return MessageType.VIDEO
    if mime_type.startswith("audio/"):
        return MessageType.VOICE
    return MessageType.DOCUMENT


def _safe_name(value: str) -> str:
    cleaned = "".join(char if char.isalnum() or char in "._ -" else "_" for char in Path(value).name)
    return cleaned[:180] or "attachment"


def _should_dispatch_workroom_event(event: dict[str, Any]) -> bool:
    """Fail closed unless the SDK verified an explicit mention/assignment."""
    routing = event.get("routing")
    return (
        isinstance(routing, dict)
        and routing.get("directedToMe") is True
        and event.get("directedToMe") is True
    )


def _should_relay_message(message: Message) -> bool:
    routing = getattr(message, "routing", None)
    return bool(
        isinstance(routing, dict)
        and routing.get("mode") == "RELAY"
        and routing.get("targetHandle")
    )


class AtalkAdapter(BasePlatformAdapter):
    """Hermes gateway adapter backed by the aTalk Python SDK."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config, Platform("atalk"))
        extra = config.extra or {}
        token = os.getenv("ATALK_AGENT_TOKEN", "").strip() or str(extra.get("token", "")).strip()
        credential_path = str(
            extra.get("credential_path")
            or os.getenv("ATALK_CREDENTIAL_PATH", "").strip()
            or Path("~/.hermes/atalk/agent-credentials.json").expanduser()
        )
        self._media_directory = Path(
            str(extra.get("media_directory") or os.getenv("ATALK_MEDIA_DIR", "~/.hermes/atalk/media"))
        ).expanduser().resolve()
        self._agent = Agent(
            token=token or None,
            base_url=str(extra.get("base_url") or os.getenv("ATALK_BASE_URL", "https://api.atalk.ar")),
            credential_path=credential_path,
        )
        self._latest_by_chat: dict[str, Message] = {}
        self._latest_workroom_event: dict[str, dict[str, Any]] = {}
        self._workroom_poll_task: asyncio.Task[None] | None = None

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._media_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._cleanup_media()
        self._agent.on_message(self._on_atalk_message)
        self._agent.on_error(self._on_atalk_error)
        await self._agent.start()
        from .tools import set_active_adapter
        set_active_adapter(self)
        self._workroom_poll_task = asyncio.create_task(self._poll_workrooms())
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        from .tools import clear_active_adapter
        clear_active_adapter(self)
        if self._workroom_poll_task:
            self._workroom_poll_task.cancel()
            await asyncio.gather(self._workroom_poll_task, return_exceptions=True)
            self._workroom_poll_task = None
        await self._agent.stop()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if chat_id.startswith("workroom:"):
            _, workroom_id, thread_id = chat_id.split(":", 2)
            detail = await self._agent.workrooms.get(workroom_id, 0, 1)
            source = self._latest_workroom_event.get(chat_id)
            operation_seed = f"{source['event']['eventId'] if source else chat_id}:reply:{content}"
            result = await self._agent.workrooms.publish_mandated({
                "workroomId": workroom_id,
                "threadId": thread_id,
                "operationId": _stable_uuid(operation_seed),
                "summary": "Reply to a directed message in an aTalk Task",
                "effect": "Share the reply with the Task participants",
                "participantPeerIds": _active_participants(detail),
                "payload": {
                    "version": 1, "kind": "message", "threadId": thread_id,
                    "body": content, "mentions": _response_mentions(source),
                    **({"replyToEventId": source["event"]["eventId"]} if source else {}),
                },
            })
            if result["status"] == "requires_approval":
                # Keep the durable Workroom cursor on this source event. Once a
                # human approves it, polling retries the same logical reply.
                raise RuntimeError(_mandate_error(result))
            if result["status"] != "executed":
                return SendResult(success=False, error=_mandate_error(result))
            return SendResult(success=True, message_id=result["value"]["event"]["eventId"])
        handle = self._handle(chat_id)
        incoming = self._latest_by_chat.get(handle)
        if incoming:
            relay_to_counterparty = _should_relay_message(incoming)
            message_id = await (incoming.relay(content) if relay_to_counterparty else incoming.reply(content))
        else:
            message_id = (await self._agent.send_with_details(handle, content)).message_id
        return SendResult(success=True, message_id=message_id)

    async def send_image_file(
        self, chat_id: str, image_path: str, caption: str | None = None,
        reply_to: str | None = None, metadata: dict[str, Any] | None = None, **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, image_path, caption, "image")

    async def send_video(
        self, chat_id: str, video_path: str, caption: str | None = None,
        reply_to: str | None = None, metadata: dict[str, Any] | None = None, **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, video_path, caption, "video")

    async def send_voice(
        self, chat_id: str, audio_path: str, caption: str | None = None,
        reply_to: str | None = None, metadata: dict[str, Any] | None = None, **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, audio_path, caption, "audio")

    async def send_document(
        self, chat_id: str, file_path: str, caption: str | None = None,
        file_name: str | None = None, reply_to: str | None = None,
        metadata: dict[str, Any] | None = None, **kwargs,
    ) -> SendResult:
        return await self._send_file(chat_id, file_path, caption, "document", file_name or kwargs.get("filename"))

    async def get_chat_info(self, chat_id: str):
        if chat_id.startswith("workroom:"):
            _, workroom_id, _ = chat_id.split(":", 2)
            detail = await self._agent.workrooms.get(workroom_id, 0, 1)
            return {
                "name": detail["descriptor"].get("title") or detail["descriptor"]["objective"],
                "type": "group",
            }
        incoming = self._latest_by_chat.get(self._handle(chat_id))
        return {
            "name": incoming.sender.get("displayName", chat_id) if incoming else chat_id,
            "type": "dm",
        }

    async def _on_atalk_message(self, message: Message) -> None:
        handle = str(message.sender["handle"])
        self._latest_by_chat[handle] = message
        await message.mark_read()
        media_urls: list[str] = []
        media_types: list[str] = []
        message_type = MessageType.TEXT
        if message.attachment:
            descriptor = message.attachment.descriptor
            target = self._media_directory / f"{descriptor['id']}-{_safe_name(str(descriptor['name']))}"
            await message.attachment.save_to(target)
            media_urls.append(str(target))
            media_types.append(str(descriptor["mimeType"]))
            message_type = _message_type(str(descriptor["mimeType"]))
        source = self.build_source(
            chat_id=handle,
            chat_name=str(message.sender.get("displayName") or handle),
            chat_type="dm",
            user_id=str(message.sender["id"]),
            user_name=str(message.sender.get("displayName") or handle),
        )
        mention_context = ""
        mentions = getattr(message, "mentions", [])
        if mentions:
            targets = ", ".join(mention["handle"] for mention in mentions)
            targeted = bool(getattr(message, "is_mentioned", False))
            mention_context = f"[aTalk explicit agent mention: {targets} | targeted_to_this_runtime={targeted}]\n\n"
        event = MessageEvent(
            text=f"{mention_context}{message.text}",
            message_type=message_type,
            user_id=str(message.sender["id"]),
            user_name=str(message.sender.get("displayName") or handle),
            source=source,
            message_id=message.id,
            media_urls=media_urls,
            media_types=media_types,
            media_text_inlined=[False] * len(media_urls),
        )
        await self.handle_message(event)

    async def _poll_workrooms(self) -> None:
        while True:
            try:
                cursor = None
                while True:
                    page = await self._agent.workrooms.list(cursor, 100)
                    for summary in page.get("workrooms", []):
                        workroom_id = summary["workroom"]["id"]

                        async def receive(event, detail=summary):
                            await self._on_workroom_event(detail, event)

                        await self._agent.workrooms.poll(workroom_id, receive)
                    cursor = page.get("nextCursor")
                    if not cursor:
                        break
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Could not poll aTalk Tasks/Workrooms")
            await asyncio.sleep(2)

    async def _on_workroom_event(self, detail: dict[str, Any], event: dict[str, Any]) -> None:
        if not _should_dispatch_workroom_event(event):
            return
        content = event["content"]
        body = _render_workroom_event(content, event["routing"])
        workroom_id = detail["workroom"]["id"]
        thread_id = event["event"]["threadId"]
        chat_id = f"workroom:{workroom_id}:{thread_id}"
        self._latest_workroom_event[chat_id] = event
        actor = event["actor"]
        source = self.build_source(
            chat_id=chat_id,
            chat_name="aTalk Task",
            chat_type="group",
            user_id=str(actor["id"]),
            user_name=str(actor.get("displayName") or actor["handle"]),
        )
        media_urls: list[str] = []
        media_types: list[str] = []
        message_type = MessageType.TEXT
        if content.get("kind") == "artifact_version":
            for descriptor in content.get("attachments", []):
                target = self._media_directory / f"{descriptor['id']}-{_safe_name(str(descriptor['name']))}"
                result = await self._agent.workrooms.save_attachment_to_mandated({
                    "workroomId": workroom_id, "threadId": thread_id,
                    "operationId": _stable_uuid(f"{event['event']['eventId']}:read:{descriptor['id']}"),
                    "descriptor": descriptor, "filePath": target,
                    "summary": f"Read Task file: {descriptor['name']}",
                    "effect": "Decrypt this Task file inside Hermes so the assigned agent can process it",
                })
                if result["status"] == "requires_approval":
                    raise RuntimeError(_mandate_error(result))
                if result["status"] != "executed":
                    # A revoked, expired or otherwise denied file must not
                    # poison the poll loop forever. Treat it as unavailable.
                    continue
                media_urls.append(str(result["value"]))
                media_types.append(str(descriptor["mimeType"]))
                message_type = _message_type(str(descriptor["mimeType"]))
        task_name = detail["descriptor"].get("title") or detail["descriptor"]["objective"]
        await self.handle_message(MessageEvent(
            text=(
                f"[aTalk encrypted Task: {task_name}; task id: {workroom_id}; thread id: {thread_id}; "
                f"objective: {detail['descriptor']['objective']}; use atalk_task_* tools for plans, "
                f"deliverables or explicit routing]\n\n{body}"
            ),
            message_type=message_type,
            user_id=str(actor["id"]),
            user_name=str(actor.get("displayName") or actor["handle"]),
            source=source,
            message_id=event["event"]["eventId"],
            media_urls=media_urls,
            media_types=media_types,
            media_text_inlined=[False] * len(media_urls),
        ))

    async def _send_file(
        self, chat_id: str, file_path: str, caption: str | None,
        expected_kind: str, display_name: str | None = None,
    ) -> SendResult:
        path = Path(file_path).expanduser().resolve()
        if not path.is_file():
            return SendResult(success=False, error="Attachment path is not a regular file")
        size = path.stat().st_size
        if size > MAX_ATTACHMENT_BYTES:
            return SendResult(success=False, error="aTalk attachments cannot exceed 100 MB")
        mime_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        if expected_kind == "image" and not mime_type.startswith("image/"):
            logger.warning("aTalk Hermes expected an image but detected %s", mime_type)
        if chat_id.startswith("workroom:"):
            _, workroom_id, thread_id = chat_id.split(":", 2)
            detail = await self._agent.workrooms.get(workroom_id, 0, 1)
            source = self._latest_workroom_event.get(chat_id)
            file_digest = _file_digest(path)
            result = await self._agent.workrooms.submit_file_mandated({
                "workroomId": workroom_id, "threadId": thread_id,
                "operationId": _stable_uuid(
                    f"{source['event']['eventId'] if source else chat_id}:file:{file_digest}:{caption or ''}",
                ),
                "filePath": path, "name": display_name or path.name, "mimeType": mime_type,
                "title": display_name or path.name,
                **({"description": caption} if caption else {}),
                "mentions": _response_mentions(source),
                "participantPeerIds": _active_participants(detail),
                "summary": f"Return {display_name or path.name} to this Task",
                "effect": "Encrypt and share the generated file with the Task participants",
            })
            if result["status"] == "requires_approval":
                raise RuntimeError(_mandate_error(result))
            if result["status"] != "executed":
                return SendResult(success=False, error=_mandate_error(result))
            return SendResult(success=True, message_id=result["value"]["record"]["event"]["eventId"])
        handle = self._handle(chat_id)
        incoming = self._latest_by_chat.get(handle)
        name = display_name or path.name
        if incoming:
            relay_to_counterparty = _should_relay_message(incoming)
            message_id = await (
                incoming.relay_attachment_file(path, mime_type, caption, name=name)
                if relay_to_counterparty
                else incoming.reply_attachment_file(path, mime_type, caption, name=name)
            )
        else:
            sent = await self._agent.send_attachment_file_with_details(handle, path, mime_type, caption, name=name)
            message_id = sent.message_id
        return SendResult(success=True, message_id=message_id)

    def _handle(self, chat_id: str) -> str:
        handle = chat_id.removeprefix("atalk:")
        return handle if handle.startswith("@") else f"@{handle}"

    def _cleanup_media(self) -> None:
        cutoff = time.time() - MEDIA_TTL_SECONDS
        for path in self._media_directory.iterdir():
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                logger.debug("Could not clean aTalk media file %s", path, exc_info=True)

    async def _on_atalk_error(self, error: Exception) -> None:
        logger.error("aTalk runtime error: %s", error)


def _stable_uuid(value: str) -> str:
    import uuid
    digest = bytearray(hashlib.sha256(value.encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _active_participants(detail: dict[str, Any]) -> list[str]:
    return [
        str(item["membership"]["peerId"])
        for item in detail.get("members", [])
        if not item["membership"].get("leftAt")
    ]


def _response_mentions(event: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not event:
        return []
    actor = event["actor"]
    return [{
        "peerId": actor["id"], "handle": actor["handle"],
        "peerType": "AGENT" if actor.get("type") == "AGENT" else "HUMAN",
        "intent": "direct",
    }]


def _render_workroom_event(
    content: dict[str, Any], routing: dict[str, Any] | None = None,
) -> str:
    kind = content.get("kind")
    if kind == "message":
        return str(content["body"])
    if kind == "activity":
        return f"{content['summary']}\n\nActivity: {content['activityType']}"
    if kind == "plan":
        assigned_steps = routing.get("assignedSteps", []) if isinstance(routing, dict) else []
        steps = "\n".join(f"- {step['title']}" for step in assigned_steps)
        return f"{content['summary']}\n\nYour executable assigned steps:\n{steps}".strip()
    if kind == "artifact_version":
        return "\n".join(str(value) for value in (
            content.get("title"), content.get("description"), content.get("fileName"),
        ) if value)
    if kind == "deliverable":
        return "\n".join(value for value in ("Deliverable submitted for review", content.get("note")) if value)
    if kind == "cost":
        return f"Task usage recorded: {content.get('metric')}"
    if kind == "approval_request":
        return f"{content.get('summary') or content.get('rationale')}\nRequested effect: {content.get('effect') or content.get('action')}"
    return "aTalk Task update"


def _mandate_error(result: dict[str, Any]) -> str:
    decision = result.get("decision") if isinstance(result.get("decision"), dict) else {}
    suffix = f": {decision['code']}" if decision.get("code") else ""
    return f"aTalk agent permission {result.get('status', 'denied')}{suffix}"
