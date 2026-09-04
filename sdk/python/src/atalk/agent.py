from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import os
import random
import uuid
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal, Protocol

import httpx
from websockets.asyncio.client import ClientConnection, connect
from websockets.exceptions import ConnectionClosed
from websockets.protocol import State

from .protocol import (
    IdentityKeys,
    attachment_part_descriptors,
    create_chunked_attachment_descriptor,
    decode_attachment_message,
    decrypt_attachment,
    decrypt_attachment_chunk,
    decrypt_text,
    encode_attachment_message,
    encrypt_attachment,
    encrypt_attachment_chunk,
    encrypt_text,
    join_encrypted_attachment_parts,
    split_encrypted_attachment,
)
from .runtime_update import (
    DEFAULT_RUNTIME_CAPABILITIES,
    RuntimeCheckIn,
    RuntimeOptions,
    RuntimeUpdateAdvisory,
    parse_runtime_update_advisory,
    persist_runtime_update_status,
    resolve_runtime_check_in,
)

_ACTIVITY_PREFIX = "__ATALK_AGENT_ACTIVITY_V1__"
_DIRECTED_MESSAGE_PREFIX = "__ATALK_DIRECTED_MESSAGE_V1__"
_FATAL_SESSION_CODES = {"AUTH_REQUIRED", "INVALID_REFRESH_TOKEN", "INVALID_SESSION", "PEER_INACTIVE"}
_MAX_PROCESSED_INCOMING = 10_000
_DEFAULT_REFRESH_LEEWAY_SECONDS = 5 * 60
_HEARTBEAT_INTERVAL_SECONDS = 25.0
_RUNTIME_CHECK_IN_INTERVAL_SECONDS = 6 * 60 * 60
_RUNTIME_CHECK_IN_JITTER = 0.1
_RUNTIME_CHECK_IN_TIMEOUT_SECONDS = 2.5


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
    access_token: str | None = None
    refresh_token: str | None = None
    access_token_expires_at: str | None = None
    refresh_request_id: str | None = None


@dataclass(frozen=True)
class RefreshedCredentials:
    access_token: str
    refresh_token: str | None = None
    access_token_expires_at: str | None = None


@dataclass(frozen=True)
class CredentialRefreshContext:
    credentials: Credentials
    reason: Literal["EXPIRING", "UNAUTHORIZED"]
    base_url: str


CredentialRefresher = Callable[
    [CredentialRefreshContext], Awaitable[RefreshedCredentials | None] | RefreshedCredentials | None,
]


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
            access_token=value.get("access_token"),
            refresh_token=value.get("refresh_token"),
            access_token_expires_at=value.get("access_token_expires_at"),
            refresh_request_id=value.get("refresh_request_id"),
        )

    async def save(self, credentials: Credentials) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        value = json.dumps({
            "session_token": credentials.session_token,
            "peer": credentials.peer,
            "keys": asdict(credentials.keys),
            **({"access_token": credentials.access_token} if credentials.access_token else {}),
            **({"refresh_token": credentials.refresh_token} if credentials.refresh_token else {}),
            **({"access_token_expires_at": credentials.access_token_expires_at} if credentials.access_token_expires_at else {}),
            **({"refresh_request_id": credentials.refresh_request_id} if credentials.refresh_request_id else {}),
        }, indent=2) + "\n"
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.{uuid.uuid4()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(value)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        os.chmod(self.path, 0o600)


@dataclass
class PendingActivation:
    request_id: str
    keys: IdentityKeys


@dataclass
class RuntimeState:
    outbox: list[dict[str, Any]]
    inbox: list[dict[str, Any]]
    processed_incoming: dict[str, str]
    counterparties: dict[str, dict[str, Any]]
    workroom_cursors: dict[str, int] = field(default_factory=dict)
    processed_workroom_events: dict[str, bool] = field(default_factory=dict)
    workroom_event_failures: dict[str, dict[str, Any]] = field(default_factory=dict)
    workroom_mandate_usage: dict[str, dict[str, Any]] = field(default_factory=dict)
    pending_activation: PendingActivation | None = None


class RuntimeStateStore(Protocol):
    async def load(self) -> RuntimeState | None: ...

    async def save(self, state: RuntimeState) -> None: ...


class MemoryRuntimeStateStore:
    def __init__(self) -> None:
        self._state: RuntimeState | None = None

    async def load(self) -> RuntimeState | None:
        if self._state is None:
            return None
        return _runtime_state_from_json(_runtime_state_to_json(self._state))

    async def save(self, state: RuntimeState) -> None:
        self._state = _runtime_state_from_json(_runtime_state_to_json(state))


class FileRuntimeStateStore:
    def __init__(self, path: str | Path):
        self.path = Path(path).resolve()

    async def load(self) -> RuntimeState | None:
        try:
            value = json.loads(self.path.read_text())
        except FileNotFoundError:
            return None
        return _runtime_state_from_json(value)

    async def save(self, state: RuntimeState) -> None:
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.{uuid.uuid4()}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            handle.write(json.dumps(_runtime_state_to_json(state), indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)
        os.chmod(self.path, 0o600)


@dataclass
class Attachment:
    descriptor: dict[str, Any]
    _download: Callable[[], Awaitable[bytes]]
    _save_to: Callable[[Path, Callable[[int, int], None] | None, asyncio.Event | None], Awaitable[Path]] | None = None

    async def download(self) -> bytes:
        return await self._download()

    async def save_to(
        self, file_path: str | Path,
        progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
    ) -> Path:
        """Decrypt and save the attachment to an explicit local path."""
        target = Path(file_path).expanduser().resolve()
        if self._save_to:
            return await self._save_to(target, progress, cancel)
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
    mentions: list[dict[str, str]]
    is_mentioned: bool
    routing: dict[str, str]
    attachment: Attachment | None
    _reply: Callable[[str], Awaitable[str]]
    _reply_attachment: Callable[[bytes, str, str, str | None], Awaitable[str]]
    _reply_attachment_file: Callable[[Path, str | None, str | None, str | None], Awaitable[str]] | None
    _relay: Callable[[str], Awaitable[str]]
    _relay_attachment: Callable[[bytes, str, str, str | None], Awaitable[str]]
    _relay_attachment_file: Callable[[Path, str | None, str | None, str | None], Awaitable[str]] | None
    _mark_read: Callable[[], Awaitable[None]]

    async def reply(self, text: str) -> str:
        return await self._reply(text)

    async def reply_attachment(
        self, data: bytes, name: str, mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return await self._reply_attachment(data, name, mime_type, caption)

    async def reply_attachment_file(
        self, file_path: str | Path, mime_type: str | None = None, caption: str | None = None,
        name: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        if self._reply_attachment_file:
            return await self._reply_attachment_file(path, mime_type, caption, name)
        return await self.reply_attachment(
            path.read_bytes(), name or path.name, mime_type or _mime_type_from_path(path), caption,
        )

    async def relay(self, text: str) -> str:
        return await self._relay(text)

    async def relay_attachment(
        self, data: bytes, name: str, mime_type: str = "application/octet-stream", caption: str | None = None,
    ) -> str:
        return await self._relay_attachment(data, name, mime_type, caption)

    async def relay_attachment_file(
        self, file_path: str | Path, mime_type: str | None = None, caption: str | None = None,
        name: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        if self._relay_attachment_file:
            return await self._relay_attachment_file(path, mime_type, caption, name)
        return await self.relay_attachment(
            path.read_bytes(), name or path.name, mime_type or _mime_type_from_path(path), caption,
        )

    async def mark_read(self) -> None:
        await self._mark_read()


@dataclass(frozen=True)
class SentMessage:
    conversation_id: str
    message_id: str


MessageHandler = Callable[[Message], Awaitable[None] | None]
ErrorHandler = Callable[[Exception], Awaitable[None] | None]
RuntimeUpdateHandler = Callable[[RuntimeUpdateAdvisory], Awaitable[None] | None]


class Agent:
    def __init__(
        self,
        *,
        token: str | None = None,
        base_url: str = "http://127.0.0.1:4001",
        credential_store: CredentialStore | None = None,
        credential_path: str | None = None,
        runtime_state_store: RuntimeStateStore | None = None,
        runtime_state_path: str | None = None,
        refresh_credentials: CredentialRefresher | None = None,
        refresh_leeway_seconds: float = _DEFAULT_REFRESH_LEEWAY_SECONDS,
        supervision: bool = True,
        connect_timeout: float = 10.0,
        runtime: RuntimeOptions | None = None,
    ):
        self._activation_token = token
        self._base_url = base_url.rstrip("/")
        self._credential_store = credential_store or FileCredentialStore(token, credential_path)
        if runtime_state_store:
            self._runtime_state_store = runtime_state_store
        elif runtime_state_path:
            self._runtime_state_store = FileRuntimeStateStore(runtime_state_path)
        elif isinstance(self._credential_store, FileCredentialStore):
            self._runtime_state_store = FileRuntimeStateStore(f"{self._credential_store.path}.runtime.json")
        else:
            self._runtime_state_store = MemoryRuntimeStateStore()
        self._uses_default_credential_refresher = refresh_credentials is None
        self._credential_refresher = refresh_credentials or self._refresh_atalk_credentials
        self._refresh_leeway_seconds = max(0.0, refresh_leeway_seconds)
        self._supervision_enabled = supervision
        self._connect_timeout = connect_timeout
        runtime = _runtime_options_for_process(runtime)
        self._runtime_check_in: RuntimeCheckIn = resolve_runtime_check_in(runtime)
        if runtime and runtime.update_status_path is False:
            self._runtime_update_status_path: Path | None = None
        elif runtime and runtime.update_status_path is not None:
            self._runtime_update_status_path = Path(runtime.update_status_path).expanduser().resolve()
        elif isinstance(self._credential_store, FileCredentialStore):
            self._runtime_update_status_path = Path(f"{self._credential_store.path}.update.json")
        else:
            self._runtime_update_status_path = None
        self._credentials: Credentials | None = None
        self._runtime_state = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})
        self._socket: ClientConnection | None = None
        self._handler: MessageHandler | None = None
        self._error_handler: ErrorHandler | None = None
        self._runtime_update_handler: RuntimeUpdateHandler | None = None
        self._runtime_update: RuntimeUpdateAdvisory | None = None
        self._supervisors: list[dict[str, Any]] = []
        self._counterparties: dict[str, dict[str, Any]] = {}
        self._processing_incoming: dict[str, asyncio.Task[None]] = {}
        self._sent_this_connection: set[str] = set()
        self._connection_task: asyncio.Task[None] | None = None
        self._heartbeat_task: asyncio.Task[None] | None = None
        self._runtime_check_in_task: asyncio.Task[None] | None = None
        self._runtime_update_tasks: set[asyncio.Task[None]] = set()
        self._inbox_retry_task: asyncio.Task[None] | None = None
        self._inbox_retry_attempt = 0
        self._ready = asyncio.Event()
        self._stopped = asyncio.Event()
        self._stopping = False
        self._send_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._outbox_lock = asyncio.Lock()
        self._refresh_lock = asyncio.Lock()
        # Late import avoids a circular runtime dependency while keeping the
        # ergonomic `agent.workrooms` surface.
        from .workrooms import WorkroomClient
        self.workrooms = WorkroomClient(self)

    @property
    def connected(self) -> bool:
        return self._socket is not None and self._ready.is_set()

    @property
    def peer(self) -> dict[str, Any] | None:
        return self._credentials.peer if self._credentials else None

    @property
    def runtime_metadata(self) -> RuntimeCheckIn:
        return self._runtime_check_in

    @property
    def runtime_update(self) -> RuntimeUpdateAdvisory | None:
        return self._runtime_update

    def on_message(self, handler: MessageHandler) -> MessageHandler:
        self._handler = handler
        return handler

    def on_error(self, handler: ErrorHandler) -> ErrorHandler:
        self._error_handler = handler
        return handler

    def on_update(self, handler: RuntimeUpdateHandler) -> RuntimeUpdateHandler:
        """Receive administrative update advisories outside the message/model channel."""
        self._runtime_update_handler = handler
        return handler

    async def start(self) -> None:
        if self._connection_task and not self._connection_task.done():
            await self._wait_until_ready()
            return
        self._runtime_state = await self._runtime_state_store.load() or RuntimeState(
            outbox=[], inbox=[], processed_incoming={}, counterparties={},
        )
        persisted_credentials = await self._credential_store.load()
        self._credentials = persisted_credentials or await self._activate()
        self._counterparties = dict(self._runtime_state.counterparties)
        self._inbox_retry_attempt = 0
        try:
            await self._prepare_and_connect()
        except AgentError as error:
            if (
                persisted_credentials is None
                or self._activation_token is None
                or error.code not in _FATAL_SESSION_CODES
            ):
                raise
            # Re-pair a revoked runtime with the keypair already on disk. A
            # fresh pair would make its encrypted Task history unreadable.
            self._credentials = await self._activate(persisted_credentials.keys)
            await self._prepare_and_connect()

    async def stop(self) -> None:
        self._stopping = True
        self._ready.clear()
        await self._stop_heartbeat()
        await self._stop_runtime_check_ins()
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
        retry_task = self._inbox_retry_task
        if retry_task and retry_task is not asyncio.current_task():
            retry_task.cancel()
            try:
                await retry_task
            except asyncio.CancelledError:
                pass
        self._inbox_retry_task = None
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
        progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
        name: str | None = None,
    ) -> str:
        return (
            await self.send_attachment_file_with_details(
                recipient_handle, file_path, mime_type, caption, progress, cancel, name,
            )
        ).conversation_id

    async def send_attachment_file_with_details(
        self, recipient_handle: str, file_path: str | Path,
        mime_type: str | None = None, caption: str | None = None,
        progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
        name: str | None = None,
    ) -> SentMessage:
        path = Path(file_path).expanduser().resolve()
        conversation_id = str(uuid.uuid4())
        message_id = await self._send_attachment_file_envelope(
            recipient_handle, path, mime_type or _mime_type_from_path(path), caption,
            conversation_id, progress, cancel, name,
        )
        return SentMessage(conversation_id=conversation_id, message_id=message_id)

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
        progress: Callable[[int, int], None] | None = None,
        cancel: asyncio.Event | None = None,
        name: str | None = None,
    ) -> str:
        path = Path(file_path).expanduser().resolve()
        return await self._send_attachment_file_envelope(
            recipient_handle, path, mime_type or _mime_type_from_path(path), caption,
            conversation_id, progress, cancel, name,
        )

    async def download_attachment(self, descriptor: dict[str, Any]) -> bytes:
        """Download an attachment descriptor retained by a durable bridge."""
        return await self._download_attachment(descriptor)

    async def mark_message_read(self, message_id: str) -> None:
        """Mark a message read when only its durable id is available."""
        await self._remember_processed(message_id, "READ")
        await self._send_frame({"kind": "ACK", "messageId": message_id, "state": "READ"})
        self._schedule_inbox_retry()

    async def _activate(self, existing_keys: IdentityKeys | None = None) -> Credentials:
        if not self._activation_token:
            raise AgentError(
                "ACTIVATION_REQUIRED",
                "Provide a one-time token because no persisted credentials were found",
            )
        pending = self._runtime_state.pending_activation
        if pending is None or (existing_keys is not None and pending.keys != existing_keys):
            pending = PendingActivation(
                request_id=str(uuid.uuid4()),
                keys=existing_keys or IdentityKeys.generate(),
            )

            def remember(state: RuntimeState) -> None:
                state.pending_activation = pending

            await self._mutate_runtime_state(remember)
        result = await self._request(
            "POST",
            "/v1/agents/activate",
            {
                "activationToken": self._activation_token,
                "activationRequestId": pending.request_id,
                "signingPublicKey": pending.keys.signing_public_key,
                "encryptionPublicKey": pending.keys.encryption_public_key,
            },
            authenticated=False,
        )
        access_token = result.get("accessToken", result["token"])
        credentials = Credentials(
            session_token=access_token,
            peer=result["peer"],
            keys=pending.keys,
            access_token=access_token,
            refresh_token=result.get("refreshToken"),
            access_token_expires_at=result.get("accessTokenExpiresAt") or result.get("expiresAt"),
        )
        await self._credential_store.save(credentials)

        def clear_pending(state: RuntimeState) -> None:
            state.pending_activation = None

        await self._mutate_runtime_state(clear_pending)
        return credentials

    async def _prepare_and_connect(self) -> None:
        await self._refresh_credentials_if_needed("EXPIRING")
        if self._supervision_enabled:
            result = await self._request("GET", "/v1/agent-runtime/supervisors")
            self._supervisors = result["supervisors"]
        self._stopping = False
        self._ready.clear()
        self._stopped.clear()
        self._connection_task = asyncio.create_task(self._connection_loop(), name="atalk-agent-connection")
        await self._wait_until_ready()
        self._start_runtime_check_ins()

    def _start_runtime_check_ins(self) -> None:
        if self._runtime_check_in_task and not self._runtime_check_in_task.done():
            return
        self._runtime_check_in_task = asyncio.create_task(
            self._runtime_check_in_loop(), name="atalk-agent-runtime-check-in",
        )

    async def _stop_runtime_check_ins(self) -> None:
        task = self._runtime_check_in_task
        self._runtime_check_in_task = None
        pending = [item for item in self._runtime_update_tasks if item is not asyncio.current_task()]
        self._runtime_update_tasks.clear()
        if task and task is not asyncio.current_task():
            pending.append(task)
        for item in pending:
            item.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    async def _runtime_check_in_loop(self) -> None:
        try:
            while not self._stopping:
                await self._check_in_runtime_safely()
                jitter = 1 - _RUNTIME_CHECK_IN_JITTER + random.random() * _RUNTIME_CHECK_IN_JITTER * 2
                await asyncio.sleep(_RUNTIME_CHECK_IN_INTERVAL_SECONDS * jitter)
        except asyncio.CancelledError:
            raise

    async def _check_in_runtime_safely(self) -> None:
        try:
            response = await asyncio.wait_for(
                self._authorized_http_request(
                    "POST",
                    "/v1/agent-runtime/check-in",
                    headers={"content-type": "application/json"},
                    json=self._runtime_check_in.to_wire(),
                    timeout=2,
                ),
                timeout=_RUNTIME_CHECK_IN_TIMEOUT_SECONDS,
            )
            # Older/self-hosted relays remain compatible with this advisory-only feature.
            if response.status_code == 404:
                return
            if response.is_error:
                self._raise_http_error(response)
            try:
                body = response.json()
            except ValueError as error:
                raise AgentError("INVALID_RUNTIME_ADVISORY", "aTalk returned invalid update metadata") from error
            advisory = parse_runtime_update_advisory(body.get("advisory") if isinstance(body, dict) else None)
            if advisory is None:
                raise AgentError("INVALID_RUNTIME_ADVISORY", "aTalk returned invalid update metadata")
            changed = not _same_runtime_advisory(self._runtime_update, advisory)
            self._runtime_update = advisory
            if self._runtime_update_status_path:
                await asyncio.to_thread(
                    persist_runtime_update_status,
                    self._runtime_update_status_path,
                    self._runtime_check_in,
                    advisory,
                    writer_peer_id=(
                        str(self._credentials.peer["id"])
                        if self._credentials and isinstance(self._credentials.peer.get("id"), str)
                        else None
                    ),
                )
            if changed and self._runtime_update_handler:
                # Consumer callbacks are advisory UI/automation hooks. Dispatch
                # them independently so a slow or broken hook cannot stop the
                # six-hour check-in loop or the messaging runtime.
                task = asyncio.create_task(
                    self._dispatch_runtime_update(advisory),
                    name="atalk-agent-runtime-update-callback",
                )
                self._runtime_update_tasks.add(task)
                task.add_done_callback(self._runtime_update_tasks.discard)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # Version metadata must never interrupt activation, messaging or a model turn.
            await self._emit_runtime_advisory_error(error)

    async def _dispatch_runtime_update(self, advisory: RuntimeUpdateAdvisory) -> None:
        try:
            handler = self._runtime_update_handler
            if handler is None:
                return
            result = handler(advisory)
            if inspect.isawaitable(result):
                await result
        except asyncio.CancelledError:
            raise
        except Exception as error:
            await self._emit_runtime_advisory_error(error)

    async def _emit_runtime_advisory_error(self, error: Exception) -> None:
        if not self._error_handler:
            return
        try:
            await self._emit_error(error)
        except asyncio.CancelledError:
            raise
        except Exception as handler_error:
            asyncio.get_running_loop().call_exception_handler({
                "message": "aTalk runtime advisory error handler failed",
                "exception": handler_error,
                "context": error,
            })

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
                    await self._refresh_credentials_if_needed("EXPIRING")
                    async with connect(websocket_url, max_size=256 * 1024, ping_interval=25, ping_timeout=20) as socket:
                        self._socket = socket
                        await socket.send(json.dumps({"kind": "AUTH", "token": _access_token(self._require_credentials())}))
                        async for raw in socket:
                            frame = json.loads(raw)
                            if frame.get("kind") == "READY":
                                attempt = 0
                                self._sent_this_connection.clear()
                                self._ready.set()
                                await self._start_heartbeat(socket)
                                await self._drain_outbox()
                                await self._drain_inbox()
                                continue
                            try:
                                await self._handle_frame(frame)
                            except AgentError as error:
                                if error.code in _FATAL_SESSION_CODES:
                                    raise
                                await self._emit_error(error)
                            except Exception as error:  # handler/protocol failure must not kill the runtime
                                await self._emit_error(error)
                                self._schedule_inbox_retry()
                except asyncio.CancelledError:
                    raise
                except AgentError as error:
                    if error.code in _FATAL_SESSION_CODES and await self._refresh_credentials_if_needed("UNAUTHORIZED", force=True):
                        continue
                    raise
                except ConnectionClosed as error:
                    if self._stopping:
                        break
                    if error.code in {4001, 1008}:
                        if await self._refresh_credentials_if_needed("UNAUTHORIZED", force=True):
                            continue
                        raise AgentError("INVALID_SESSION", "Agent credentials were rejected") from error
                    await self._emit_error(error)
                except Exception as error:
                    if self._stopping:
                        break
                    await self._emit_error(error)
                finally:
                    await self._stop_heartbeat()
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
            await self._stop_heartbeat()
            self._socket = None
            self._ready.clear()
            self._stopped.set()

    async def _start_heartbeat(self, socket: ClientConnection) -> None:
        await self._stop_heartbeat()
        self._heartbeat_task = asyncio.create_task(
            self._heartbeat_loop(socket), name="atalk-agent-heartbeat",
        )

    async def _stop_heartbeat(self) -> None:
        task = self._heartbeat_task
        self._heartbeat_task = None
        if task is None or task is asyncio.current_task():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _wait_for_heartbeat(self) -> None:
        await asyncio.sleep(_HEARTBEAT_INTERVAL_SECONDS)

    async def _heartbeat_loop(self, socket: ClientConnection) -> None:
        try:
            while not self._stopping:
                await self._wait_for_heartbeat()
                if not await self._send_heartbeat(socket):
                    return
        except asyncio.CancelledError:
            raise
        except ConnectionClosed:
            # The receive loop owns reconnect decisions and will observe the
            # same close without emitting a duplicate error.
            return
        except Exception as error:
            await self._emit_error(error)
            try:
                await socket.close(code=1011, reason="Heartbeat failed")
            except Exception:
                pass

    async def _send_heartbeat(self, socket: ClientConnection) -> bool:
        if (
            self._stopping
            or not self._ready.is_set()
            or self._socket is not socket
            or getattr(socket, "state", State.OPEN) != State.OPEN
        ):
            return False
        async with self._send_lock:
            if (
                self._stopping
                or not self._ready.is_set()
                or self._socket is not socket
                or getattr(socket, "state", State.OPEN) != State.OPEN
            ):
                return False
            await socket.send(json.dumps({"kind": "PING"}))
        return True

    async def _handle_frame(self, frame: dict[str, Any]) -> None:
        kind = frame.get("kind")
        if kind == "ERROR":
            raise AgentError(str(frame.get("code", "PROTOCOL_ERROR")), str(frame.get("message", "Unknown protocol error")))
        if kind == "RECEIPT":
            await self._remove_from_outbox(str(frame["messageId"]))
            await self._send_frame({"kind": "RECEIPT_ACK", "messageId": frame["messageId"], "state": frame["state"]})
            return
        if kind == "ACK_RECEIVED":
            await self._forget_incoming(str(frame["messageId"]))
            return
        if kind != "MESSAGE":
            return
        message_id = str(frame["envelope"]["message_id"])
        confirmed = self._runtime_state.processed_incoming.get(message_id)
        if confirmed:
            await self._send_frame({"kind": "ACK", "messageId": message_id, "state": confirmed})
            self._schedule_inbox_retry()
            return
        await self._remember_incoming(frame["envelope"])
        existing = self._processing_incoming.get(message_id)
        if existing:
            await existing
            return
        processing = asyncio.create_task(self._process_incoming_message(frame))
        self._processing_incoming[message_id] = processing
        try:
            await processing
        finally:
            self._processing_incoming.pop(message_id, None)

    async def _process_incoming_message(self, frame: dict[str, Any]) -> None:
        credentials = self._require_credentials()
        envelope = frame["envelope"]
        sender = await self._request("GET", f"/v1/messages/{envelope['message_id']}/sender-keys")
        text = decrypt_text(
            envelope=envelope,
            sender_signing_public_key=sender["signingPublicKey"],
            sender_encryption_public_key=sender["encryptionPublicKey"],
            recipient_encryption_secret_key=credentials.keys.encryption_secret_key,
        )
        directed_message = _decode_directed_message(text)
        content = str(directed_message["content"]) if directed_message else text
        mentions = list(directed_message["mentions"]) if directed_message else []
        attachment_message = decode_attachment_message(content)
        is_supervisor = any(supervisor["id"] == sender["id"] for supervisor in self._supervisors)
        is_mentioned = any(mention["peerId"] == credentials.peer["id"] for mention in mentions)
        counterparty = self._counterparties.get(envelope["conversation_id"]) if is_supervisor else sender
        routing = (
            {"mode": "RELAY", "targetHandle": str(counterparty["handle"])}
            if is_supervisor and not is_mentioned and counterparty
            else {"mode": "REPLY", "targetHandle": str(sender["handle"])}
        )
        if not is_supervisor:
            self._counterparties[envelope["conversation_id"]] = sender
            await self._mutate_runtime_state(
                lambda state: state.counterparties.__setitem__(envelope["conversation_id"], sender),
            )
            await self._mirror_activity(
                "INCOMING", sender, text, envelope["conversation_id"], envelope["message_id"], envelope["timestamp"],
            )
        if not self._handler:
            raise AgentError("MESSAGE_HANDLER_NOT_CONFIGURED", "Register a message handler before start()")
        acknowledged_state = "DELIVERED"
        handler_complete = False

        async def handle() -> None:
            nonlocal acknowledged_state, handler_complete

            async def reply(reply_text: str) -> str:
                return await self._send_envelope(sender["handle"], reply_text, envelope["conversation_id"])

            async def reply_attachment(data: bytes, name: str, mime_type: str, caption: str | None) -> str:
                return await self._send_attachment_envelope(
                    sender["handle"], data, name, mime_type, caption, envelope["conversation_id"],
                )

            async def reply_attachment_file(
                path: Path, mime_type: str | None, caption: str | None, name: str | None,
            ) -> str:
                return await self._send_attachment_file_envelope(
                    sender["handle"], path, mime_type or _mime_type_from_path(path), caption,
                    envelope["conversation_id"], None, None, name,
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

            async def relay_attachment_file(
                path: Path, mime_type: str | None, caption: str | None, name: str | None,
            ) -> str:
                if not is_supervisor:
                    raise RuntimeError("Only supervisor messages can be relayed")
                counterparty = self._counterparties.get(envelope["conversation_id"])
                if not counterparty:
                    raise RuntimeError("No active counterparty exists for this supervised conversation")
                return await self._send_attachment_file_envelope(
                    counterparty["handle"], path, mime_type or _mime_type_from_path(path), caption,
                    envelope["conversation_id"], None, None, name,
                )

            async def mark_read() -> None:
                nonlocal acknowledged_state
                if not handler_complete:
                    acknowledged_state = "READ"
                    return
                await self.mark_message_read(str(envelope["message_id"]))

            result = self._handler(Message(
                id=envelope["message_id"],
                conversation_id=envelope["conversation_id"],
                text=str(attachment_message.get("caption", "")) if attachment_message else content,
                sender=sender,
                received_at=_parse_timestamp(envelope["timestamp"]),
                is_supervisor=is_supervisor,
                mentions=mentions,
                is_mentioned=is_mentioned,
                routing=routing,
                attachment=Attachment(
                    descriptor=attachment_message["attachment"],
                    _download=lambda: self._download_attachment(attachment_message["attachment"]),
                    _save_to=lambda path, progress, cancel: self._download_attachment_to_file(
                        attachment_message["attachment"], path, progress, cancel,
                    ),
                ) if attachment_message else None,
                _reply=reply,
                _reply_attachment=reply_attachment,
                _reply_attachment_file=reply_attachment_file,
                _relay=relay,
                _relay_attachment=relay_attachment,
                _relay_attachment_file=relay_attachment_file,
                _mark_read=mark_read,
            ))
            if inspect.isawaitable(result):
                await result
        await handle()
        handler_complete = True
        await self._remember_processed(str(envelope["message_id"]), acknowledged_state)
        await self._send_frame({"kind": "ACK", "messageId": envelope["message_id"], "state": acknowledged_state})
        self._schedule_inbox_retry()

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
        is_supervisor = any(supervisor["id"] == recipient["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[conversation_id] = recipient
            await self._mutate_runtime_state(
                lambda state: state.counterparties.__setitem__(conversation_id, recipient),
            )
        await self._queue_envelope(envelope)
        if not is_supervisor:
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
        is_supervisor = any(supervisor["id"] == recipient["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[conversation_id] = recipient
            await self._mutate_runtime_state(
                lambda state: state.counterparties.__setitem__(conversation_id, recipient),
            )
        await self._queue_envelope(envelope)
        if not is_supervisor:
            await self._mirror_activity(
                "OUTGOING", recipient, plaintext, conversation_id, envelope["message_id"], envelope["timestamp"],
            )
        return str(envelope["message_id"])

    async def _send_attachment_file_envelope(
        self, recipient_handle: str, path: Path, mime_type: str, caption: str | None,
        conversation_id: str, progress: Callable[[int, int], None] | None,
        cancel: asyncio.Event | None, name: str | None,
    ) -> str:
        credentials = self._require_credentials()
        if not path.is_file():
            raise ValueError("ATTACHMENT_NOT_A_FILE")
        result = await self._request("POST", "/v1/messages/authorize", {"recipientHandle": recipient_handle})
        recipient = result["recipient"]
        descriptor = create_chunked_attachment_descriptor(
            attachment_id=str(uuid.uuid4()), size=path.stat().st_size, name=(name or path.name),
            mime_type=mime_type, next_id=lambda: str(uuid.uuid4()),
        )
        transferred = 0
        try:
            with path.open("rb") as source:
                for index, chunk in enumerate(descriptor["chunks"]):
                    self._raise_if_transfer_cancelled(cancel)
                    plaintext = source.read(int(chunk["plaintextSize"]))
                    if len(plaintext) != int(chunk["plaintextSize"]):
                        raise ValueError("ATTACHMENT_SIZE_MISMATCH")
                    ciphertext = encrypt_attachment_chunk(plaintext, descriptor, index)
                    await self._upload_attachment(recipient["id"], chunk["id"], ciphertext, cancel=cancel)
                    transferred += len(plaintext)
                    if progress:
                        progress(transferred, int(descriptor["size"]))
        except BaseException:
            # Also remove a chunk whose POST committed but whose response was
            # lost. The descriptor is not published until every chunk exists.
            await asyncio.gather(
                *(self._delete_attachment_part(str(chunk["id"])) for chunk in descriptor["chunks"]),
                return_exceptions=True,
            )
            raise
        plaintext = encode_attachment_message(descriptor, caption)
        envelope = encrypt_text(
            message_id=str(uuid.uuid4()), conversation_id=conversation_id,
            sender_peer_id=credentials.peer["id"], recipient_peer_id=recipient["id"],
            timestamp=_utc_now(), plaintext=plaintext,
            sender_signing_secret_key=credentials.keys.signing_secret_key,
            sender_encryption_secret_key=credentials.keys.encryption_secret_key,
            recipient_encryption_public_key=recipient["encryptionPublicKey"],
        )
        is_supervisor = any(supervisor["id"] == recipient["id"] for supervisor in self._supervisors)
        if not is_supervisor:
            self._counterparties[conversation_id] = recipient
            await self._mutate_runtime_state(lambda state: state.counterparties.__setitem__(conversation_id, recipient))
        await self._queue_envelope(envelope)
        if not is_supervisor:
            await self._mirror_activity(
                "OUTGOING", recipient, plaintext, conversation_id, envelope["message_id"], envelope["timestamp"],
            )
        return str(envelope["message_id"])

    async def _upload_attachment(
        self, recipient_peer_id: str, attachment_id: str, ciphertext: bytes,
        *, cancel: asyncio.Event | None = None, max_attempts: int = 3,
    ) -> None:
        await self._upload_attachment_scope(
            f"recipientPeerId={recipient_peer_id}", attachment_id, ciphertext,
            cancel=cancel, max_attempts=max_attempts,
        )

    async def _upload_workroom_attachment(
        self, workroom_id: str, attachment_id: str, ciphertext: bytes,
        *, cancel: asyncio.Event | None = None, max_attempts: int = 3,
    ) -> None:
        await self._upload_attachment_scope(
            f"workroomId={workroom_id}", attachment_id, ciphertext,
            cancel=cancel, max_attempts=max_attempts,
        )

    async def _upload_attachment_scope(
        self, scope_query: str, attachment_id: str, ciphertext: bytes,
        *, cancel: asyncio.Event | None = None, max_attempts: int = 3,
    ) -> None:
        self._raise_if_transfer_cancelled(cancel)
        try:
            existing = await self._authorized_http_request("HEAD", f"/v1/attachments/{attachment_id}", timeout=30)
            if not existing.is_error:
                return
        except Exception:
            # HEAD is only a resume probe; retry the actual upload if it fails.
            pass
        path = f"/v1/attachments/{attachment_id}?{scope_query}"
        last_error: Exception | None = None
        attempts = max(1, min(max_attempts, 5))
        for attempt in range(attempts):
            self._raise_if_transfer_cancelled(cancel)
            try:
                response = await self._authorized_http_request(
                    "POST", path, headers={"content-type": "application/octet-stream"}, content=ciphertext, timeout=120,
                )
            except Exception as error:
                last_error = error
                if attempt + 1 < attempts:
                    await self._transfer_retry_delay(cancel, attempt)
                continue
            if not response.is_error:
                return
            try:
                self._raise_http_error(response)
            except Exception as error:
                last_error = error
            if response.status_code < 500 and response.status_code != 429:
                raise last_error
            if attempt + 1 < attempts:
                await self._transfer_retry_delay(cancel, attempt)
        raise last_error or RuntimeError("ATTACHMENT_UPLOAD_FAILED")

    async def _delete_attachment_part(self, attachment_id: str) -> None:
        await self._authorized_http_request("DELETE", f"/v1/attachments/{attachment_id}", timeout=30)

    async def _download_attachment(self, descriptor: dict[str, Any]) -> bytes:
        parts = []
        for part in attachment_part_descriptors(descriptor):
            parts.append(await self._download_attachment_part(str(part["id"])))
        return decrypt_attachment(join_encrypted_attachment_parts(parts, descriptor), descriptor)

    async def _download_attachment_to_file(
        self, descriptor: dict[str, Any], target: Path,
        progress: Callable[[int, int], None] | None,
        cancel: asyncio.Event | None,
    ) -> Path:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if int(descriptor.get("version", 1)) == 1:
            self._raise_if_transfer_cancelled(cancel)
            target.write_bytes(await self._download_attachment(descriptor))
            os.chmod(target, 0o600)
            if progress:
                progress(int(descriptor["size"]), int(descriptor["size"]))
            return target
        temporary = target.with_name(f".{target.name}.{os.getpid()}.{uuid.uuid4()}.part")
        transferred = 0
        try:
            descriptor_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor_fd, "wb") as output:
                for index, chunk in enumerate(descriptor["chunks"]):
                    self._raise_if_transfer_cancelled(cancel)
                    ciphertext = await self._download_attachment_part(str(chunk["id"]), cancel=cancel)
                    plaintext = decrypt_attachment_chunk(ciphertext, descriptor, index)
                    output.write(plaintext)
                    transferred += len(plaintext)
                    if progress:
                        progress(transferred, int(descriptor["size"]))
                output.flush()
                os.fsync(output.fileno())
            os.replace(temporary, target)
            os.chmod(target, 0o600)
            return target
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise

    @staticmethod
    def _raise_if_transfer_cancelled(cancel: asyncio.Event | None) -> None:
        if cancel and cancel.is_set():
            raise asyncio.CancelledError("Attachment transfer was cancelled")

    async def _download_attachment_part(
        self, attachment_id: str, *, cancel: asyncio.Event | None = None, max_attempts: int = 3,
    ) -> bytes:
        last_error: Exception | None = None
        attempts = max(1, min(max_attempts, 5))
        for attempt in range(attempts):
            self._raise_if_transfer_cancelled(cancel)
            try:
                response = await self._authorized_http_request("GET", f"/v1/attachments/{attachment_id}", timeout=120)
            except Exception as error:
                last_error = error
                if attempt + 1 < attempts:
                    await self._transfer_retry_delay(cancel, attempt)
                continue
            if not response.is_error:
                return response.content
            try:
                self._raise_http_error(response)
            except Exception as error:
                last_error = error
            if response.status_code < 500 and response.status_code != 429:
                raise last_error
            if attempt + 1 < attempts:
                await self._transfer_retry_delay(cancel, attempt)
        raise last_error or RuntimeError("ATTACHMENT_DOWNLOAD_FAILED")

    async def _transfer_retry_delay(self, cancel: asyncio.Event | None, attempt: int) -> None:
        delay = 0.25 * (2 ** attempt)
        if cancel is None:
            await asyncio.sleep(delay)
            return
        try:
            await asyncio.wait_for(cancel.wait(), timeout=delay)
        except TimeoutError:
            return
        self._raise_if_transfer_cancelled(cancel)

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
                message_id=_deterministic_uuid(f"{source_message_id}:{supervisor['id']}:{direction}:activity"),
                conversation_id=conversation_id,
                sender_peer_id=credentials.peer["id"],
                recipient_peer_id=supervisor["id"],
                timestamp=_utc_now(),
                plaintext=plaintext,
                sender_signing_secret_key=credentials.keys.signing_secret_key,
                sender_encryption_secret_key=credentials.keys.encryption_secret_key,
                recipient_encryption_public_key=supervisor["encryptionPublicKey"],
            )
            await self._queue_envelope(envelope)

    async def _queue_envelope(self, envelope: dict[str, Any]) -> None:
        def append(state: RuntimeState) -> None:
            if not any(item.get("message_id") == envelope.get("message_id") for item in state.outbox):
                state.outbox.append(envelope)
        await self._mutate_runtime_state(append)
        if self.connected:
            await self._drain_outbox()

    async def _remove_from_outbox(self, message_id: str) -> None:
        if not any(item.get("message_id") == message_id for item in self._runtime_state.outbox):
            return
        await self._mutate_runtime_state(
            lambda state: setattr(
                state, "outbox", [item for item in state.outbox if item.get("message_id") != message_id],
            ),
        )
        self._sent_this_connection.discard(message_id)

    async def _drain_outbox(self) -> None:
        async with self._outbox_lock:
            while self.connected:
                envelope = next(
                    (item for item in self._runtime_state.outbox if item.get("message_id") not in self._sent_this_connection),
                    None,
                )
                if envelope is None:
                    return
                await self._send_frame({"kind": "DELIVER", "envelope": envelope})
                self._sent_this_connection.add(str(envelope["message_id"]))

    async def _remember_incoming(self, envelope: dict[str, Any]) -> None:
        message_id = str(envelope["message_id"])
        if any(item.get("message_id") == message_id for item in self._runtime_state.inbox):
            return

        def append(runtime: RuntimeState) -> None:
            if not any(item.get("message_id") == message_id for item in runtime.inbox):
                runtime.inbox.append(envelope)
        await self._mutate_runtime_state(append)

    async def _forget_incoming(self, message_id: str) -> None:
        if not any(item.get("message_id") == message_id for item in self._runtime_state.inbox):
            return
        await self._mutate_runtime_state(
            lambda runtime: setattr(
                runtime, "inbox", [item for item in runtime.inbox if item.get("message_id") != message_id],
            ),
        )
        if not self._runtime_state.inbox:
            self._inbox_retry_attempt = 0
            retry_task = self._inbox_retry_task
            if retry_task and retry_task is not asyncio.current_task():
                retry_task.cancel()
                self._inbox_retry_task = None

    async def _drain_inbox(self) -> None:
        if not self.connected:
            self._schedule_inbox_retry()
            return
        for envelope in list(self._runtime_state.inbox):
            try:
                await self._handle_frame({"kind": "MESSAGE", "envelope": envelope})
            except Exception as error:
                await self._emit_error(error)
                self._schedule_inbox_retry()
                return
        if not self._runtime_state.inbox:
            self._inbox_retry_attempt = 0

    def _schedule_inbox_retry(self) -> None:
        if self._stopping or not self._runtime_state.inbox:
            return
        if self._inbox_retry_task and not self._inbox_retry_task.done():
            return

        async def retry() -> None:
            while not self._stopping and self._runtime_state.inbox:
                await asyncio.sleep(_reconnect_delay(self._inbox_retry_attempt))
                self._inbox_retry_attempt += 1
                await self._drain_inbox()

        self._inbox_retry_task = asyncio.create_task(retry(), name="atalk-agent-inbox-retry")

    async def _remember_processed(self, message_id: str, state: str) -> None:
        def remember(runtime: RuntimeState) -> None:
            runtime.processed_incoming[message_id] = "READ" if runtime.processed_incoming.get(message_id) == "READ" else state
            overflow = len(runtime.processed_incoming) - _MAX_PROCESSED_INCOMING
            for old_id in list(runtime.processed_incoming)[:max(0, overflow)]:
                runtime.processed_incoming.pop(old_id, None)
        await self._mutate_runtime_state(remember)

    async def _mutate_runtime_state(self, mutator: Callable[[RuntimeState], None]) -> None:
        async with self._state_lock:
            next_state = _runtime_state_from_json(_runtime_state_to_json(self._runtime_state))
            mutator(next_state)
            await self._runtime_state_store.save(next_state)
            self._runtime_state = next_state

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
            response = await self._authorized_http_request(method, path, headers=headers, json=payload)
        else:
            async with httpx.AsyncClient(base_url=self._base_url, timeout=10) as client:
                response = await client.request(method, path, headers=headers, json=payload)
        body = response.json()
        if response.is_error:
            self._raise_http_error(response, body)
        return body

    async def _authorized_http_request(
        self,
        method: str,
        path: str,
        *,
        headers: dict[str, str] | None = None,
        json: dict[str, Any] | None = None,
        content: bytes | None = None,
        timeout: float = 10,
        retry: bool = True,
    ) -> httpx.Response:
        await self._refresh_credentials_if_needed("EXPIRING")
        request_headers = {
            "authorization": f"Bearer {_access_token(self._require_credentials())}",
            **(headers or {}),
        }
        async with httpx.AsyncClient(base_url=self._base_url, timeout=timeout) as client:
            response = await client.request(method, path, headers=request_headers, json=json, content=content)
        if response.status_code == 401 and retry and await self._refresh_credentials_if_needed("UNAUTHORIZED", force=True):
            return await self._authorized_http_request(
                method, path, headers=headers, json=json, content=content, timeout=timeout, retry=False,
            )
        return response

    async def _refresh_credentials_if_needed(
        self, reason: Literal["EXPIRING", "UNAUTHORIZED"], *, force: bool = False,
    ) -> bool:
        if not self._credential_refresher or not self._credentials:
            return False
        if reason == "EXPIRING" and not force:
            expires_at = self._credentials.access_token_expires_at
            if not expires_at:
                return False
            try:
                expiry = _parse_timestamp(expires_at).timestamp()
            except ValueError:
                return False
            if expiry > datetime.now(timezone.utc).timestamp() + self._refresh_leeway_seconds:
                return False
        observed_credentials = self._credentials
        async with self._refresh_lock:
            if self._credentials is not observed_credentials:
                return True
            current = self._require_credentials()
            if self._uses_default_credential_refresher and current.refresh_token and not current.refresh_request_id:
                current = replace(current, refresh_request_id=str(uuid.uuid4()))
                # Commit the operation id before the request so a crash or lost
                # response can safely replay the same server-side rotation.
                await self._credential_store.save(current)
                self._credentials = current
            try:
                result = self._credential_refresher(CredentialRefreshContext(
                    credentials=current, reason=reason, base_url=self._base_url,
                ))
                refreshed = await result if inspect.isawaitable(result) else result
            except AgentError as error:
                if (
                    self._uses_default_credential_refresher
                    and current.refresh_request_id
                    and error.code in _FATAL_SESSION_CODES
                ):
                    restored = replace(current, refresh_request_id=None)
                    await self._credential_store.save(restored)
                    self._credentials = restored
                raise
            if refreshed is None:
                return False
            next_credentials = Credentials(
                session_token=refreshed.access_token,
                access_token=refreshed.access_token,
                refresh_token=refreshed.refresh_token or current.refresh_token,
                access_token_expires_at=refreshed.access_token_expires_at,
                peer=current.peer,
                keys=current.keys,
            )
            await self._credential_store.save(next_credentials)
            self._credentials = next_credentials
            return True

    async def _refresh_atalk_credentials(
        self, context: CredentialRefreshContext,
    ) -> RefreshedCredentials | None:
        refresh_token = context.credentials.refresh_token
        if not refresh_token:
            return None
        async with httpx.AsyncClient(base_url=context.base_url, timeout=10) as client:
            response = await client.post(
                "/v1/agent-runtime/session/refresh",
                headers={"content-type": "application/json"},
                json={
                    "refreshToken": refresh_token,
                    "requestId": context.credentials.refresh_request_id
                    or _deterministic_uuid(f"atalk-agent-refresh:{refresh_token}"),
                },
            )
        if response.is_error:
            self._raise_http_error(response)
        body = response.json()
        access_token = body.get("accessToken") or body.get("token")
        if not access_token:
            raise AgentError("INVALID_REFRESH_RESPONSE", "aTalk did not return an access token")
        return RefreshedCredentials(
            access_token=str(access_token),
            refresh_token=str(body["refreshToken"]) if body.get("refreshToken") else None,
            access_token_expires_at=str(body.get("accessTokenExpiresAt") or body.get("expiresAt"))
            if body.get("accessTokenExpiresAt") or body.get("expiresAt") else None,
        )

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


def _decode_directed_message(value: str) -> dict[str, Any] | None:
    if not value.startswith(_DIRECTED_MESSAGE_PREFIX):
        return None
    try:
        payload = json.loads(value[len(_DIRECTED_MESSAGE_PREFIX):])
        if (
            not isinstance(payload, dict)
            or payload.get("version") != 1
            or payload.get("kind") != "DIRECTED_MESSAGE"
            or not isinstance(payload.get("content"), str)
            or not isinstance(payload.get("mentions"), list)
            or not 1 <= len(payload["mentions"]) <= 32
        ):
            return None
        mentions: list[dict[str, str]] = []
        for mention in payload["mentions"]:
            if (
                not isinstance(mention, dict)
                or mention.get("type") != "AGENT"
                or not isinstance(mention.get("peerId"), str)
                or not isinstance(mention.get("handle"), str)
            ):
                return None
            uuid.UUID(mention["peerId"])
            mentions.append({"peerId": mention["peerId"], "handle": mention["handle"], "type": "AGENT"})
        return {"content": payload["content"], "mentions": mentions}
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def _same_runtime_advisory(
    left: RuntimeUpdateAdvisory | None, right: RuntimeUpdateAdvisory,
) -> bool:
    if left is None:
        return False
    # checkedAt changes on every poll and is deliberately not a user-visible change.
    return replace(left, checked_at=right.checked_at) == right


def _runtime_options_for_process(options: RuntimeOptions | None) -> RuntimeOptions | None:
    managed = os.getenv("ATALK_RUNTIME_MANAGER", "").strip().lower() in {"1", "true", "yes"}
    if not managed or (options and options.update_status_path is False):
        return options
    current = options or RuntimeOptions()
    capabilities = list(current.capabilities or DEFAULT_RUNTIME_CAPABILITIES)
    if "runtime.auto-update" not in capabilities:
        capabilities.append("runtime.auto-update")
    configured_status_path = os.getenv("ATALK_UPDATE_STATUS_PATH", "").strip()
    return RuntimeOptions(
        integration=current.integration,
        host=current.host,
        channel=current.channel,
        capabilities=capabilities,
        update_status_path=current.update_status_path or configured_status_path or None,
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _access_token(credentials: Credentials) -> str:
    return credentials.access_token or credentials.session_token


def _deterministic_uuid(value: str) -> str:
    digest = bytearray(hashlib.sha256(value.encode()).digest()[:16])
    digest[6] = (digest[6] & 0x0F) | 0x40
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest)))


def _runtime_state_to_json(state: RuntimeState) -> dict[str, Any]:
    return {
        "version": 1,
        "outbox": state.outbox,
        "inbox": state.inbox,
        "processedIncoming": state.processed_incoming,
        "counterparties": state.counterparties,
        "workroomCursors": state.workroom_cursors,
        "processedWorkroomEvents": state.processed_workroom_events,
        "workroomEventFailures": state.workroom_event_failures,
        "workroomMandateUsage": state.workroom_mandate_usage,
        **({"pendingActivation": {
            "requestId": state.pending_activation.request_id,
            "keys": asdict(state.pending_activation.keys),
        }} if state.pending_activation else {}),
    }


def _runtime_state_from_json(value: Any) -> RuntimeState:
    if not isinstance(value, dict):
        return RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})
    return RuntimeState(
        outbox=list(value.get("outbox", [])) if isinstance(value.get("outbox", []), list) else [],
        inbox=list(value.get("inbox", [])) if isinstance(value.get("inbox", []), list) else [],
        processed_incoming=dict(value.get("processedIncoming", {}))
        if isinstance(value.get("processedIncoming", {}), dict) else {},
        counterparties=dict(value.get("counterparties", {}))
        if isinstance(value.get("counterparties", {}), dict) else {},
        workroom_cursors={str(key): int(cursor) for key, cursor in value.get("workroomCursors", {}).items()}
        if isinstance(value.get("workroomCursors", {}), dict) else {},
        processed_workroom_events={str(key): bool(processed) for key, processed in value.get("processedWorkroomEvents", {}).items()}
        if isinstance(value.get("processedWorkroomEvents", {}), dict) else {},
        workroom_event_failures=_workroom_event_failures_from_json(value.get("workroomEventFailures")),
        workroom_mandate_usage={str(key): dict(usage) for key, usage in value.get("workroomMandateUsage", {}).items()
        if isinstance(value.get("workroomMandateUsage", {}), dict) and isinstance(usage, dict)}
        if isinstance(value.get("workroomMandateUsage", {}), dict) else {},
        pending_activation=_pending_activation_from_json(value.get("pendingActivation")),
    )


def _workroom_event_failures_from_json(value: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(value, dict):
        return {}
    valid: list[tuple[str, dict[str, Any]]] = []
    for key, candidate in value.items():
        if (
            isinstance(key, str)
            and isinstance(candidate, dict)
            and isinstance(candidate.get("workroomId"), str)
            and isinstance(candidate.get("eventId"), str)
            and (candidate.get("envelopeId") is None or isinstance(candidate.get("envelopeId"), str))
            and isinstance(candidate.get("sequence"), int)
            and not isinstance(candidate.get("sequence"), bool)
            and candidate["sequence"] >= 0
            and isinstance(candidate.get("attempts"), int)
            and not isinstance(candidate.get("attempts"), bool)
            and candidate["attempts"] >= 0
            and candidate.get("reason") in {"legacy_audit_only", "processing_failed"}
            and isinstance(candidate.get("lastError"), str)
            and candidate.get("status") in {"retrying", "quarantined"}
            and isinstance(candidate.get("updatedAt"), str)
        ):
            valid.append((key, dict(candidate)))
    return dict(valid[-1_000:])


def _pending_activation_from_json(value: Any) -> PendingActivation | None:
    if not isinstance(value, dict) or not isinstance(value.get("requestId"), str):
        return None
    keys = value.get("keys")
    if not isinstance(keys, dict) or not all(isinstance(keys.get(field), str) for field in (
        "signing_public_key", "signing_secret_key", "encryption_public_key", "encryption_secret_key",
    )):
        return None
    return PendingActivation(request_id=value["requestId"], keys=IdentityKeys(**keys))


def _reconnect_delay(attempt: int) -> float:
    base = min(30.0, 0.5 * (2 ** min(attempt, 6)))
    return base + random.uniform(0.1, max(0.1, base * 0.25))


def _mime_type_from_path(path: Path) -> str:
    import mimetypes
    return mimetypes.guess_type(path.name)[0] or "application/octet-stream"
