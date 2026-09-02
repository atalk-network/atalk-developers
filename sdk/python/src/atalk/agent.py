from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import random
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Awaitable, Callable, Protocol

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed

from .protocol import (
    IdentityKeys,
    attachment_part_descriptors,
    decode_attachment_message,
    decrypt_attachment,
    decrypt_text,
    encode_attachment_message,
    encrypt_attachment,
    encrypt_text,
    join_encrypted_attachment_parts,
    split_encrypted_attachment,
)

_ACTIVITY_PREFIX = "__ATALK_AGENT_ACTIVITY_V1__"
_FATAL_SESSION_CODES = {"AUTH_REQUIRED", "INVALID_SESSION", "PEER_INACTIVE"}


class AgentError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Credentials:
    session_token: str
    peer: dict[str, Any]
    keys: IdentityKeys


class CredentialStore(Protocol):
    async def load(self) -> Credentials | None: ...

    async def save(self, credentials: Credentials) -> None: ...


class FileCredentialStore:
    def __init__(self, activation_token: str | None = None, path: str | None = None):
        if path:
            self.path = Path(path).resolve()
        elif activation_token:
            suffix = hashlib.sha256(activation_token.encode()).hexdigest()[:16]
            self.path = Path(f".atalk/agent-{suffix}.json").resolve()
        else:
            raise ValueError("An activation token or an explicit credential path is required")

    async def load(self) -> Credentials | None:
        try:
            value = json.loads(self.path.read_text())
        except FileNotFoundError:
            return None
        return Credentials(
            session_token=value["session_token"],
            peer=value["peer"],
            keys=IdentityKeys(**value["keys"]),
        )

    async def save(self, credentials: Credentials) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.path.write_text(json.dumps({
            "session_token": credentials.session_token,
            "peer": credentials.peer,
            "keys": asdict(credentials.keys),
        }, indent=2) + "\n")
        os.chmod(self.path, 0o600)


@dataclass
class Attachment:
    descriptor: dict[str, Any]
    _download: Callable[[], Awaitable[bytes]]

    async def download(self) -> bytes:
        return await self._download()

    async def save_to(self, file_path: str | Path) -> Path:
        """Decrypt and save the attachment to an explicit local path."""
        target = Path(file_path).expanduser().resolve()
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        target.write_bytes(await self.download())
        os.chmod(target, 0o600)
        return target


@dataclass
class Message:
    id: str
    conversation_id: str
    text: str
    sender: dict[str, Any]
    received_at: datetime
    is_supervisor: bool
    attachment: Attachment | None
    _reply: Callable[[str], Awaitable[str]]
    _reply_attachment: Callable[[bytes, str, str, str | None], Awaitable[str]]
    _relay: Callable[[str], Awaitable[str]]
    _relay_attachment: Callable[[bytes, str, str, str | None], Awaitable[str]]
    _mark_read: Callable[[], Awaitable[None]]

    async def reply(self, text: str) -> str:
        return await self._reply(text)

    async def reply_attachment(
        self, data: bytes, name: str, mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return await self._reply_attachment(data, name, mime_type, caption)

    async def reply_attachment_file(
        self, file_path: str | Path, mime_type: str | None = None, caption: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        return await self.reply_attachment(
            path.read_bytes(), path.name, mime_type or _mime_type_from_path(path), caption,
        )

    async def relay(self, text: str) -> str:
        return await self._relay(text)

    async def relay_attachment(
        self, data: bytes, name: str, mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return await self._relay_attachment(data, name, mime_type, caption)

    async def relay_attachment_file(
        self, file_path: str | Path, mime_type: str | None = None, caption: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        return await self.relay_attachment(
            path.read_bytes(), path.name, mime_type or _mime_type_from_path(path), caption,
        )

    async def mark_read(self) -> None:
        await self._mark_read()


@dataclass(frozen=True)
class SentMessage:
    conversation_id: str
    message_id: str


MessageHandler = Callable[[Message], Awaitable[None] | None]
ErrorHandler = Callable[[Exception], Awaitable[None] | None]


class Agent:
    def __init__(
        self,
        *,
        token: str | None = None,
        base_url: str = "http://127.0.0.1:4001",
        credential_store: CredentialStore | None = None,
        credential_path: str | None = None,
        supervision: bool = True,
        connect_timeout: float = 10.0,
    ):
        self._activation_token = token
        self._base_url = base_url.rstrip("/")
        self._credential_store = credential_store or FileCredentialStore(token, credential_path)
        self._supervision_enabled = supervision
        self._connect_timeout = connect_timeout
        self._credentials: Credentials | None = None
        self._socket: ClientConnection | None = None
        self._handler: MessageHandler | None = None
        self._error_handler: ErrorHandler | None = None
        self._supervisors: list[dict[str, Any]] = []
        self._counterparties: dict[str, dict[str, Any]] = {}
        self._connection_task: asyncio.Task[None] | None = None
        self._ready = asyncio.Event()
        self._stopped = asyncio.Event()
        self._stopping = False
        self._send_lock = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self._socket is not None and self._ready.is_set()

    @property
    def peer(self) -> dict[str, Any] | None:
        return self._credentials.peer if self._credentials else None

    def on_message(self, handler: MessageHandler) -> MessageHandler:
        self._handler = handler
        return handler

    def on_error(self, handler: ErrorHandler) -> ErrorHandler:
        self._error_handler = handler
        return handler

    async def start(self) -> None:
        if self._connection_task and not self._connection_task.done():
            await self._wait_until_ready()
            return
        self._credentials = await self._credential_store.load() or await self._activate()
        if self._supervision_enabled:
            result = await self._request("GET", "/v1/agent-runtime/supervisors")
            self._supervisors = result["supervisors"]
        self._stopping = False
        self._ready.clear()
        self._stopped.clear()
        self._connection_task = asyncio.create_task(self._connection_loop(), name="atalk-agent-connection")
        await self._wait_until_ready()

    async def stop(self) -> None:
        self._stopping = True
        self._ready.clear()
        socket = self._socket
        if socket is not None:
            await socket.close(code=1000, reason="Agent stopped")
        task = self._connection_task
        if task and task is not asyncio.current_task():
            if not task.done():
                task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._stopped.set()

    def run(self) -> None:
        async def main() -> None:
            await self.start()
            await self._stopped.wait()
            if self._connection_task:
                await self._connection_task
        asyncio.run(main())

    async def send(self, recipient_handle: str, text: str) -> str:
        return (await self.send_with_details(recipient_handle, text)).conversation_id

    async def send_with_details(self, recipient_handle: str, text: str) -> SentMessage:
        conversation_id = str(uuid.uuid4())
        message_id = await self._send_envelope(recipient_handle, text, conversation_id)
        return SentMessage(conversation_id=conversation_id, message_id=message_id)

    async def send_in_conversation(self, recipient_handle: str, text: str, conversation_id: str) -> str:
        """Send inside a known conversation and return the new message id."""
        return await self._send_envelope(recipient_handle, text, conversation_id)

    async def send_attachment(
        self, recipient_handle: str, data: bytes, name: str,
        mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return (await self.send_attachment_with_details(recipient_handle, data, name, mime_type, caption)).conversation_id

    async def send_attachment_with_details(
        self, recipient_handle: str, data: bytes, name: str,
        mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> SentMessage:
        conversation_id = str(uuid.uuid4())
        message_id = await self._send_attachment_envelope(
            recipient_handle, data, name, mime_type, caption, conversation_id,
        )
        return SentMessage(conversation_id=conversation_id, message_id=message_id)

    async def send_attachment_file(
        self, recipient_handle: str, file_path: str | Path,
        mime_type: str | None = None, caption: str | None = None,
    ) -> str:
        return (
            await self.send_attachment_file_with_details(recipient_handle, file_path, mime_type, caption)
        ).conversation_id

    async def send_attachment_file_with_details(
        self, recipient_handle: str, file_path: str | Path,
        mime_type: str | None = None, caption: str | None = None,
    ) -> SentMessage:
        path = Path(file_path).expanduser().resolve()
        return await self.send_attachment_with_details(
            recipient_handle, path.read_bytes(), path.name, mime_type or _mime_type_from_path(path), caption,
        )

    async def send_attachment_in_conversation(
        self, recipient_handle: str, data: bytes, name: str, conversation_id: str,
        mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return await self._send_attachment_envelope(
            recipient_handle, data, name, mime_type, caption, conversation_id,
        )

    async def send_attachment_file_in_conversation(
        self, recipient_handle: str, file_path: str | Path, conversation_id: str,
        mime_type: str | None = None, caption: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        return await self.send_attachment_in_conversation(
            recipient_handle,
            path.read_bytes(),
            path.name,
            conversation_id,
            mime_type or _mime_type_from_path(path),
            caption,
        )

    async def _activate(self) -> Credentials:
        if not self._activation_token:
            raise AgentError(
                "ACTIVATION_REQUIRED",
                "Provide a one-time token because no persisted credentials were found",
            )
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
        await self._credential_store.save(credentials)
        return credentials

    async def _wait_until_ready(self) -> None:
        task = self._connection_task
        if task is None:
            raise RuntimeError("Agent connection was not started")
        ready_wait = asyncio.create_task(self._ready.wait())
        done, _ = await asyncio.wait(
            {ready_wait, task}, timeout=self._connect_timeout, return_when=asyncio.FIRST_COMPLETED,
        )
        if ready_wait in done and self._ready.is_set():
            return
        ready_wait.cancel()
        if task in done:
            await task
        await self.stop()
        raise TimeoutError("aTalk connection timed out")

    async def _connection_loop(self) -> None:
        attempt = 0
        try:
            while not self._stopping:
                websocket_url = self._base_url.replace("http://", "ws://", 1).replace("https://", "wss://", 1) + "/v1/ws"
                try:
                    async with connect(websocket_url, max_size=256 * 1024, ping_interval=25, ping_timeout=20) as socket:
                        self._socket = socket
                        await socket.send(json.dumps({"kind": "AUTH", "token": self._require_credentials().session_token}))
                        async for raw in socket:
                            frame = json.loads(raw)
                            if frame.get("kind") == "READY":
                                attempt = 0
                                self._ready.set()
                                continue
                            try:
                                await self._handle_frame(frame)
                            except AgentError as error:
                                if error.code in _FATAL_SESSION_CODES:
                                    raise
                                await self._emit_error(error)
                            except Exception as error:  # handler/protocol failure must not kill the runtime
                                await self._emit_error(error)
                except asyncio.CancelledError:
                    raise
                except AgentError:
                    raise
                except ConnectionClosed as error:
                    if self._stopping:
                        break
                    if error.code in {4001, 1008}:
                        raise AgentError("INVALID_SESSION", "Agent credentials were revoked") from error
                    await self._emit_error(error)
                except Exception as error:
                    if self._stopping:
                        break
                    await self._emit_error(error)
                finally:
                    self._socket = None
                    self._ready.clear()
                if self._stopping:
                    break
                await asyncio.sleep(_reconnect_delay(attempt))
                attempt += 1
        except AgentError as error:
            self._stopping = True
            await self._emit_error(error)
            raise
        finally:
            self._socket = None
            self._ready.clear()
            self._stopped.set()

    async def _handle_frame(self, frame: dict[str, Any]) -> None:
        kind = frame.get("kind")
        if kind == "ERROR":
            raise AgentError(str(frame.get("code", "PROTOCOL_ERROR")), str(frame.get("message", "Unknown protocol error")))
        if kind == "RECEIPT":
            await self._send_frame({"kind": "RECEIPT_ACK", "messageId": frame["messageId"], "state": frame["state"]})
            return
        if kind != "MESSAGE":
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
        attachment_message = decode_attachment_message(text)
        is_supervisor = any(supervisor["id"] == sender["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[envelope["conversation_id"]] = sender
            await self._mirror_activity(
                "INCOMING", sender, text, envelope["conversation_id"], envelope["message_id"], envelope["timestamp"],
            )
        await self._send_frame({"kind": "ACK", "messageId": envelope["message_id"], "state": "DELIVERED"})
        if self._handler:
            async def reply(reply_text: str) -> str:
                return await self._send_envelope(sender["handle"], reply_text, envelope["conversation_id"])

            async def reply_attachment(data: bytes, name: str, mime_type: str, caption: str | None) -> str:
                return await self._send_attachment_envelope(
                    sender["handle"], data, name, mime_type, caption, envelope["conversation_id"],
                )

            async def relay(relay_text: str) -> str:
                if not is_supervisor:
                    raise RuntimeError("Only supervisor messages can be relayed")
                counterparty = self._counterparties.get(envelope["conversation_id"])
                if not counterparty:
                    raise RuntimeError("No active counterparty exists for this supervised conversation")
                return await self._send_envelope(counterparty["handle"], relay_text, envelope["conversation_id"])

            async def relay_attachment(data: bytes, name: str, mime_type: str, caption: str | None) -> str:
                if not is_supervisor:
                    raise RuntimeError("Only supervisor messages can be relayed")
                counterparty = self._counterparties.get(envelope["conversation_id"])
                if not counterparty:
                    raise RuntimeError("No active counterparty exists for this supervised conversation")
                return await self._send_attachment_envelope(
                    counterparty["handle"], data, name, mime_type, caption, envelope["conversation_id"],
                )

            async def mark_read() -> None:
                await self._send_frame({"kind": "ACK", "messageId": envelope["message_id"], "state": "READ"})

            result = self._handler(Message(
                id=envelope["message_id"],
                conversation_id=envelope["conversation_id"],
                text=str(attachment_message.get("caption", "")) if attachment_message else text,
                sender=sender,
                received_at=_parse_timestamp(envelope["timestamp"]),
                is_supervisor=is_supervisor,
                attachment=Attachment(
                    descriptor=attachment_message["attachment"],
                    _download=lambda: self._download_attachment(attachment_message["attachment"]),
                ) if attachment_message else None,
                _reply=reply,
                _reply_attachment=reply_attachment,
                _relay=relay,
                _relay_attachment=relay_attachment,
                _mark_read=mark_read,
            ))
            if inspect.isawaitable(result):
                await result

    async def _send_envelope(self, recipient_handle: str, text: str, conversation_id: str) -> str:
        credentials = self._require_credentials()
        result = await self._request("POST", "/v1/messages/authorize", {"recipientHandle": recipient_handle})
        recipient = result["recipient"]
        envelope = encrypt_text(
            message_id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            sender_peer_id=credentials.peer["id"],
            recipient_peer_id=recipient["id"],
            timestamp=_utc_now(),
            plaintext=text,
            sender_signing_secret_key=credentials.keys.signing_secret_key,
            sender_encryption_secret_key=credentials.keys.encryption_secret_key,
            recipient_encryption_public_key=recipient["encryptionPublicKey"],
        )
        await self._send_frame({"kind": "DELIVER", "envelope": envelope})
        is_supervisor = any(supervisor["id"] == recipient["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[conversation_id] = recipient
            await self._mirror_activity(
                "OUTGOING", recipient, text, conversation_id, envelope["message_id"], envelope["timestamp"],
            )
        return str(envelope["message_id"])

    async def _send_attachment_envelope(
        self,
        recipient_handle: str,
        data: bytes,
        name: str,
        mime_type: str,
        caption: str | None,
        conversation_id: str,
    ) -> str:
        credentials = self._require_credentials()
        result = await self._request("POST", "/v1/messages/authorize", {"recipientHandle": recipient_handle})
        recipient = result["recipient"]
        descriptor, ciphertext = encrypt_attachment(
            attachment_id=str(uuid.uuid4()), data=data, name=name, mime_type=mime_type,
        )
        descriptor, parts = split_encrypted_attachment(descriptor, ciphertext, lambda: str(uuid.uuid4()))
        for part_id, part in parts:
            await self._upload_attachment(recipient["id"], part_id, part)
        plaintext = encode_attachment_message(descriptor, caption)
        envelope = encrypt_text(
            message_id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            sender_peer_id=credentials.peer["id"],
            recipient_peer_id=recipient["id"],
            timestamp=_utc_now(),
            plaintext=plaintext,
            sender_signing_secret_key=credentials.keys.signing_secret_key,
            sender_encryption_secret_key=credentials.keys.encryption_secret_key,
            recipient_encryption_public_key=recipient["encryptionPublicKey"],
        )
        await self._send_frame({"kind": "DELIVER", "envelope": envelope})
        is_supervisor = any(supervisor["id"] == recipient["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[conversation_id] = recipient
            await self._mirror_activity(
                "OUTGOING", recipient, plaintext, conversation_id, envelope["message_id"], envelope["timestamp"],
            )
        return str(envelope["message_id"])

    async def _upload_attachment(
        self, recipient_peer_id: str, attachment_id: str, ciphertext: bytes,
    ) -> None:
        headers = {
            "authorization": f"Bearer {self._require_credentials().session_token}",
            "content-type": "application/octet-stream",
        }
        path = f"/v1/attachments/{attachment_id}?recipientPeerId={recipient_peer_id}"
        async with httpx.AsyncClient(base_url=self._base_url, timeout=120) as client:
            response = await client.post(path, headers=headers, content=ciphertext)
        if response.is_error:
            self._raise_http_error(response)

    async def _download_attachment(self, descriptor: dict[str, Any]) -> bytes:
        headers = {"authorization": f"Bearer {self._require_credentials().session_token}"}
        parts = []
        async with httpx.AsyncClient(base_url=self._base_url, timeout=120) as client:
            for part in attachment_part_descriptors(descriptor):
                response = await client.get(f"/v1/attachments/{part['id']}", headers=headers)
                if response.is_error:
                    self._raise_http_error(response)
                parts.append(response.content)
        return decrypt_attachment(join_encrypted_attachment_parts(parts, descriptor), descriptor)

    async def _mirror_activity(
        self,
        direction: str,
        counterparty: dict[str, Any],
        text: str,
        conversation_id: str,
        source_message_id: str,
        observed_at: str,
    ) -> None:
        if not self._supervision_enabled or not self._supervisors:
            return
        credentials = self._require_credentials()
        activity = {
            "version": 1,
            "kind": "AGENT_ACTIVITY",
            "agentPeerId": credentials.peer["id"],
            "agentHandle": credentials.peer["handle"],
            "counterpartyPeerId": counterparty["id"],
            "counterpartyHandle": counterparty["handle"],
            "counterpartyDisplayName": counterparty["displayName"],
            "direction": direction,
            "sourceMessageId": source_message_id,
            "observedAt": observed_at,
            "text": text,
        }
        plaintext = _ACTIVITY_PREFIX + json.dumps(activity, ensure_ascii=False, separators=(",", ":"))
        for supervisor in self._supervisors:
            envelope = encrypt_text(
                message_id=str(uuid.uuid4()),
                conversation_id=conversation_id,
                sender_peer_id=credentials.peer["id"],
                recipient_peer_id=supervisor["id"],
                timestamp=_utc_now(),
                plaintext=plaintext,
                sender_signing_secret_key=credentials.keys.signing_secret_key,
                sender_encryption_secret_key=credentials.keys.encryption_secret_key,
                recipient_encryption_public_key=supervisor["encryptionPublicKey"],
            )
            await self._send_frame({"kind": "DELIVER", "envelope": envelope})

    async def _send_frame(self, frame: dict[str, Any]) -> None:
        socket = self._socket
        if socket is None or not self._ready.is_set():
            raise RuntimeError("Agent is not connected")
        async with self._send_lock:
            await socket.send(json.dumps(frame))

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        *,
        authenticated: bool = True,
    ) -> dict[str, Any]:
        headers = {"content-type": "application/json"}
        if authenticated:
            headers["authorization"] = f"Bearer {self._require_credentials().session_token}"
        async with httpx.AsyncClient(base_url=self._base_url, timeout=10) as client:
            response = await client.request(method, path, headers=headers, json=payload)
        body = response.json()
        if response.is_error:
            self._raise_http_error(response, body)
        return body

    @staticmethod
    def _raise_http_error(response: httpx.Response, body: dict[str, Any] | None = None) -> None:
        if body is None:
            try:
                body = response.json()
            except ValueError:
                body = {}
        error = body.get("error", {})
        raise AgentError(str(error.get("code", response.status_code)), str(error.get("message", "request failed")))

    def _require_credentials(self) -> Credentials:
        if self._credentials is None:
            raise RuntimeError("Agent has not been started")
        return self._credentials

    async def _emit_error(self, error: Exception) -> None:
        if self._error_handler:
            result = self._error_handler(error)
            if inspect.isawaitable(result):
                await result
            return
        asyncio.get_running_loop().call_exception_handler({"message": "Unhandled aTalk agent error", "exception": error})


def _utc_now() -> str:
    from datetime import timezone
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _reconnect_delay(attempt: int) -> float:
    base = min(30.0, 0.5 * (2 ** min(attempt, 6)))
    return base + random.uniform(0.1, max(0.1, base * 0.25))


def _mime_type_from_path(path: Path) -> str:
    import mimetypes
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"
