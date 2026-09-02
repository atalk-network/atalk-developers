from __future__ import annotations

import logging
import mimetypes
import os
import time
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

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        self._media_directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._cleanup_media()
        self._agent.on_message(self._on_atalk_message)
        self._agent.on_error(self._on_atalk_error)
        await self._agent.start()
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        await self._agent.stop()
        self._mark_disconnected()

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        handle = self._handle(chat_id)
        incoming = self._latest_by_chat.get(handle)
        if incoming:
            message_id = await (incoming.relay(content) if incoming.is_supervisor else incoming.reply(content))
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
        event = MessageEvent(
            text=message.text,
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
        handle = self._handle(chat_id)
        incoming = self._latest_by_chat.get(handle)
        data = path.read_bytes()
        name = display_name or path.name
        if incoming:
            message_id = await (
                incoming.relay_attachment(data, name, mime_type, caption)
                if incoming.is_supervisor
                else incoming.reply_attachment(data, name, mime_type, caption)
            )
        else:
            sent = await self._agent.send_attachment_with_details(handle, data, name, mime_type, caption)
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
