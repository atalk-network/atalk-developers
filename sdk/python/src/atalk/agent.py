from __future__ import annotations

import asyncio
import hashlib
import json
import os
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from websockets.asyncio.client import ClientConnection, connect

from .protocol import IdentityKeys, decrypt_text, encrypt_text


@dataclass
class Credentials:
    session_token: str
    peer: dict[str, Any]
    keys: IdentityKeys


@dataclass
class Message:
    id: str
    conversation_id: str
    text: str
    sender: dict[str, Any]
    received_at: str
    _reply: Callable[[str], Awaitable[None]]

    async def reply(self, text: str) -> None:
        await self._reply(text)


MessageHandler = Callable[[Message], Awaitable[None]]


class Agent:
    def __init__(self, *, token: str, base_url: str = "http://127.0.0.1:4001", credential_path: str | None = None):
        self._activation_token = token
        self._base_url = base_url.rstrip("/")
        suffix = hashlib.sha256(token.encode()).hexdigest()[:16]
        self._credential_path = Path(credential_path or f".atalk/agent-{suffix}.json")
        self._credentials: Credentials | None = None
        self._socket: ClientConnection | None = None
        self._handler: MessageHandler | None = None

    def on_message(self, handler: MessageHandler) -> MessageHandler:
        self._handler = handler
        return handler

    async def start(self) -> None:
        self._credentials = self._load_credentials() or await self._activate()
        websocket_url = self._base_url.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/v1/ws"
        async with connect(websocket_url, max_size=256 * 1024) as socket:
            self._socket = socket
            await socket.send(json.dumps({"kind": "AUTH", "token": self._credentials.session_token}))
            async for raw in socket:
                await self._handle_frame(json.loads(raw))

    def run(self) -> None:
        asyncio.run(self.start())

    async def send(self, recipient_handle: str, text: str, conversation_id: str | None = None) -> str:
        credentials = self._require_credentials()
        if self._socket is None:
            raise RuntimeError("Agent is not connected")
        result = await self._request("POST", "/v1/messages/authorize", {"recipientHandle": recipient_handle})
        recipient = result["recipient"]
        envelope = encrypt_text(
            message_id=str(uuid.uuid4()),
            conversation_id=conversation_id or str(uuid.uuid4()),
            sender_peer_id=credentials.peer["id"],
            recipient_peer_id=recipient["id"],
            timestamp=_utc_now(),
            plaintext=text,
            sender_signing_secret_key=credentials.keys.signing_secret_key,
            sender_encryption_secret_key=credentials.keys.encryption_secret_key,
            recipient_encryption_public_key=recipient["encryptionPublicKey"],
        )
        await self._socket.send(json.dumps({"kind": "DELIVER", "envelope": envelope}))
        return str(envelope["message_id"])

    async def _activate(self) -> Credentials:
        keys = IdentityKeys.generate()
        result = await self._request(
            "POST",
            "/v1/agents/activate",
            {
                "activationToken": self._activation_token,
                "signingPublicKey": keys.signing_public_key,
                "encryptionPublicKey": keys.encryption_public_key,
            },
            authenticated=False,
        )
        credentials = Credentials(session_token=result["token"], peer=result["peer"], keys=keys)
        self._save_credentials(credentials)
        return credentials

    async def _handle_frame(self, frame: dict[str, Any]) -> None:
        if frame.get("kind") == "ERROR":
            raise RuntimeError(f"{frame.get('code')}: {frame.get('message')}")
        if frame.get("kind") != "MESSAGE":
            return
        credentials = self._require_credentials()
        envelope = frame["envelope"]
        sender = await self._request("GET", f"/v1/peers/{envelope['sender_peer_id']}/keys")
        text = decrypt_text(
            envelope=envelope,
            sender_signing_public_key=sender["signingPublicKey"],
            sender_encryption_public_key=sender["encryptionPublicKey"],
            recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
        )
        assert self._socket is not None
        await self._socket.send(json.dumps({"kind": "ACK", "messageId": envelope["message_id"], "state": "DELIVERED"}))
        if self._handler:
            async def reply(reply_text: str) -> None:
                await self.send(sender["handle"], reply_text, envelope["conversation_id"])
            await self._handler(Message(
                id=envelope["message_id"],
                conversation_id=envelope["conversation_id"],
                text=text,
                sender=sender,
                received_at=envelope["timestamp"],
                _reply=reply,
            ))

    async def _request(self, method: str, path: str, payload: dict[str, Any] | None = None, *, authenticated: bool = True) -> dict[str, Any]:
        headers = {"content-type": "application/json"}
        if authenticated:
            headers["authorization"] = f"Bearer {self._require_credentials().session_token}"
        async with httpx.AsyncClient(base_url=self._base_url, timeout=10) as client:
            response = await client.request(method, path, headers=headers, json=payload)
        body = response.json()
        if response.is_error:
            error = body.get("error", {})
            raise RuntimeError(f"{error.get('code', response.status_code)}: {error.get('message', 'request failed')}")
        return body

    def _load_credentials(self) -> Credentials | None:
        try:
            value = json.loads(self._credential_path.read_text())
        except FileNotFoundError:
            return None
        return Credentials(
            session_token=value["session_token"],
            peer=value["peer"],
            keys=IdentityKeys(**value["keys"]),
        )

    def _save_credentials(self, credentials: Credentials) -> None:
        self._credential_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self._credential_path.write_text(json.dumps({
            "session_token": credentials.session_token,
            "peer": credentials.peer,
            "keys": asdict(credentials.keys),
        }, indent=2) + "\n")
        os.chmod(self._credential_path, 0o600)

    def _require_credentials(self) -> Credentials:
        if self._credentials is None:
            raise RuntimeError("Agent has not been started")
        return self._credentials


def _utc_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
