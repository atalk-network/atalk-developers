from __future__ import annotations

import os
import logging
from pathlib import Path
from typing import Any

from atalk import Agent, Message
from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult


logger = logging.getLogger(__name__)


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
        self._agent = Agent(
            token=token or None,
            base_url=str(extra.get("base_url") or os.getenv("ATALK_BASE_URL", "https://api.atalk.ar")),
            credential_path=credential_path,
        )
        self._latest_by_chat: dict[str, Message] = {}

    async def connect(self, *, is_reconnect: bool = False) -> bool:
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
        handle = chat_id.removeprefix("atalk:")
        if not handle.startswith("@"):
            handle = f"@{handle}"
        incoming = self._latest_by_chat.get(handle)
        if incoming:
            message_id = await (incoming.relay(content) if incoming.is_supervisor else incoming.reply(content))
        else:
            message_id = (await self._agent.send_with_details(handle, content)).message_id
        return SendResult(success=True, message_id=message_id)

    async def get_chat_info(self, chat_id: str):
        incoming = self._latest_by_chat.get(chat_id.removeprefix("atalk:"))
        return {
            "name": incoming.sender.get("displayName", chat_id) if incoming else chat_id,
            "type": "dm",
        }

    async def _on_atalk_message(self, message: Message) -> None:
        handle = str(message.sender["handle"])
        self._latest_by_chat[handle] = message
        await message.mark_read()
        source = self.build_source(
            chat_id=handle,
            chat_name=str(message.sender.get("displayName") or handle),
            chat_type="dm",
            user_id=str(message.sender["id"]),
            user_name=str(message.sender.get("displayName") or handle),
        )
        event = MessageEvent(
            text=message.text,
            message_type=MessageType.TEXT,
            user_id=str(message.sender["id"]),
            user_name=str(message.sender.get("displayName") or handle),
            source=source,
            message_id=message.id,
        )
        await self.handle_message(event)

    async def _on_atalk_error(self, error: Exception) -> None:
        logger.error("aTalk runtime error: %s", error)
