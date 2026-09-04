import json
import os
import uuid

import pytest
import atalk.agent as agent_module

from atalk import (
    Agent,
    AgentError,
    Attachment,
    CredentialRefreshContext,
    Credentials,
    FileCredentialStore,
    FileRuntimeStateStore,
    MemoryRuntimeStateStore,
    RefreshedCredentials,
    RuntimeState,
)
from atalk.protocol import (
    IdentityKeys,
    decode_attachment_message,
    decrypt_attachment_chunk,
    decrypt_text,
    encrypt_text,
)


class FakeSocket:
    def __init__(self):
        self.frames = []

    async def send(self, value):
        self.frames.append(json.loads(value))


class FakeAgent(Agent):
    def __init__(self, credentials, peers, recipient):
        super().__init__(
            token="activation-token-placeholder",
            supervision=True,
            runtime_state_store=MemoryRuntimeStateStore(),
        )
        self._credentials = credentials
        self._peers = peers
        self._recipient = recipient
        self._socket = FakeSocket()
        self._ready.set()
        self._historical_senders = {}
        self.requested_paths = []

    async def _request(self, method, path, payload=None, *, authenticated=True):
        self.requested_paths.append(path)
        if path == "/v1/messages/authorize":
            return {"recipient": self._recipient[payload["recipientHandle"]]}
        if path.startswith("/v1/messages/") and path.endswith("/sender-keys"):
            return self._historical_senders[path.split("/")[-2]]
        if path.startswith("/v1/peers/"):
            return self._peers[path.split("/")[-2]]
        raise AssertionError(f"Unexpected request: {method} {path}")

    async def _handle_frame(self, frame):
        if frame.get("kind") == "MESSAGE":
            envelope = frame["envelope"]
            self._historical_senders[envelope["message_id"]] = self._peers[envelope["sender_peer_id"]]
        await super()._handle_frame(frame)


def peer(peer_type, handle, display_name, keys):
    return {
        "id": str(uuid.uuid4()),
        "type": peer_type,
        "status": "ACTIVE",
        "handle": handle,
        "displayName": display_name,
        "signingPublicKey": keys.signing_public_key,
        "encryptionPublicKey": keys.encryption_public_key,
    }


@pytest.mark.asyncio
async def test_sends_and_mirrors_activity_then_accepts_supervisor_intervention():
    agent_keys = IdentityKeys.generate()
    counterparty_keys = IdentityKeys.generate()
    supervisor_keys = IdentityKeys.generate()
    agent_peer = peer("AGENT", "@research.demo", "Research", agent_keys)
    counterparty = peer("AGENT", "@sales.demo", "Sales", counterparty_keys)
    supervisor = peer("HUMAN", "@operator", "Operator", supervisor_keys)
    credentials = Credentials(session_token="s" * 48, peer=agent_peer, keys=agent_keys)
    runtime = FakeAgent(
        credentials,
        {counterparty["id"]: counterparty, supervisor["id"]: supervisor},
        {counterparty["handle"]: counterparty},
    )
    runtime._supervisors = [supervisor]

    conversation_id = await runtime.send(counterparty["handle"], "Need a delivery window")
    assert uuid.UUID(conversation_id)
    delivered = runtime._socket.frames[0]["envelope"]
    mirrored = runtime._socket.frames[1]["envelope"]
    assert delivered["conversation_id"] == conversation_id
    assert decrypt_text(
        envelope=delivered,
        sender_signing_public_key=agent_peer["signingPublicKey"],
        sender_encryption_public_key=agent_peer["encryptionPublicKey"],
        recipient_encryption_secret_key=counterparty_keys.encryption_secret_key,
    ) == "Need a delivery window"
    activity = decrypt_text(
        envelope=mirrored,
        sender_signing_public_key=agent_peer["signingPublicKey"],
        sender_encryption_public_key=agent_peer["encryptionPublicKey"],
        recipient_encryption_secret_key=supervisor_keys.encryption_secret_key,
    )
    assert activity.startswith("__ATALK_AGENT_ACTIVITY_V1__")
    assert json.loads(activity.removeprefix("__ATALK_AGENT_ACTIVITY_V1__"))["direction"] == "OUTGOING"
    assert {item["message_id"] for item in runtime._runtime_state.outbox} == {
        delivered["message_id"], mirrored["message_id"],
    }
    runtime._sent_this_connection.clear()
    await runtime._drain_outbox()
    assert len([
        frame for frame in runtime._socket.frames
        if frame.get("envelope", {}).get("message_id") == delivered["message_id"]
    ]) == 2
    await runtime._handle_frame({"kind": "RECEIPT", "messageId": delivered["message_id"], "state": "DELIVERED"})
    assert {item["message_id"] for item in runtime._runtime_state.outbox} == {mirrored["message_id"]}

    seen = []

    @runtime.on_message
    async def intervene(message):
        seen.append(message)
        assert message.is_supervisor is True
        await message.mark_read()
        assert uuid.UUID(await message.relay("Move delivery to 09:00"))

    frame_count_before_intervention = len(runtime._socket.frames)
    intervention = encrypt_text(
        message_id=str(uuid.uuid4()),
        conversation_id=conversation_id,
        sender_peer_id=supervisor["id"],
        recipient_peer_id=agent_peer["id"],
        timestamp="2026-08-29T12:00:00.000Z",
        plaintext="__ATALK_DIRECTED_MESSAGE_V1__" + json.dumps({
            "version": 1,
            "kind": "DIRECTED_MESSAGE",
            "content": "Please intervene",
            "mentions": [{"peerId": agent_peer["id"], "handle": agent_peer["handle"], "type": "AGENT"}],
        }),
        sender_signing_secret_key=supervisor_keys.signing_secret_key,
        sender_encryption_secret_key=supervisor_keys.encryption_secret_key,
        recipient_encryption_public_key=agent_keys.encryption_public_key,
    )
    await runtime._handle_frame({"kind": "MESSAGE", "envelope": intervention})
    assert len(seen) == 1
    assert seen[0].text == "Please intervene"
    assert seen[0].is_mentioned is True
    assert seen[0].mentions == [{"peerId": agent_peer["id"], "handle": agent_peer["handle"], "type": "AGENT"}]
    assert any(
        frame == {"kind": "ACK", "messageId": intervention["message_id"], "state": "READ"}
        for frame in runtime._socket.frames
    )
    await runtime._handle_frame({
        "kind": "ACK_RECEIVED", "messageId": intervention["message_id"], "state": "READ",
    })
    relayed = next(
        frame["envelope"] for frame in runtime._socket.frames[frame_count_before_intervention:]
        if frame["kind"] == "DELIVER" and frame["envelope"]["recipient_peer_id"] == counterparty["id"]
    )
    assert decrypt_text(
        envelope=relayed,
        sender_signing_public_key=agent_peer["signingPublicKey"],
        sender_encryption_public_key=agent_peer["encryptionPublicKey"],
        recipient_encryption_secret_key=counterparty_keys.encryption_secret_key,
    ) == "Move delivery to 09:00"


@pytest.mark.asyncio
async def test_acknowledges_receipts():
    keys = IdentityKeys.generate()
    agent_peer = peer("AGENT", "@receipt.demo", "Receipt", keys)
    runtime = FakeAgent(Credentials("s" * 48, agent_peer, keys), {}, {})
    message_id = str(uuid.uuid4())
    await runtime._handle_frame({"kind": "RECEIPT", "messageId": message_id, "state": "DELIVERED"})
    assert runtime._socket.frames == [{"kind": "RECEIPT_ACK", "messageId": message_id, "state": "DELIVERED"}]


@pytest.mark.asyncio
async def test_only_acknowledges_after_handler_success_and_deduplicates_confirmed_delivery():
    agent_keys = IdentityKeys.generate()
    sender_keys = IdentityKeys.generate()
    agent_peer = peer("AGENT", "@receiver.demo", "Receiver", agent_keys)
    sender = peer("HUMAN", "@sender.demo", "Sender", sender_keys)
    runtime = FakeAgent(Credentials("s" * 48, agent_peer, agent_keys), {sender["id"]: sender}, {})
    calls = 0

    @runtime.on_message
    async def fail_once(_message):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("transient handler failure")

    envelope = encrypt_text(
        message_id=str(uuid.uuid4()),
        conversation_id=str(uuid.uuid4()),
        sender_peer_id=sender["id"],
        recipient_peer_id=agent_peer["id"],
        timestamp="2026-09-03T12:00:00.000Z",
        plaintext="retry me",
        sender_signing_secret_key=sender_keys.signing_secret_key,
        sender_encryption_secret_key=sender_keys.encryption_secret_key,
        recipient_encryption_public_key=agent_keys.encryption_public_key,
    )
    frame = {"kind": "MESSAGE", "envelope": envelope}
    with pytest.raises(RuntimeError, match="transient handler failure"):
        await runtime._handle_frame(frame)
    assert f"/v1/messages/{envelope['message_id']}/sender-keys" in runtime.requested_paths
    assert not any(item.get("kind") == "ACK" for item in runtime._socket.frames)
    assert [item["message_id"] for item in runtime._runtime_state.inbox] == [envelope["message_id"]]

    await runtime._handle_frame(frame)
    await runtime._handle_frame(frame)
    assert calls == 2
    acknowledgements = [item for item in runtime._socket.frames if item.get("kind") == "ACK"]
    assert len(acknowledgements) == 2
    await runtime._handle_frame({
        "kind": "ACK_RECEIVED", "messageId": envelope["message_id"], "state": "DELIVERED",
    })
    assert runtime._runtime_state.inbox == []


@pytest.mark.asyncio
async def test_runtime_state_store_is_private_and_credentials_can_refresh(tmp_path):
    state_path = tmp_path / "nested" / "runtime.json"
    state_store = FileRuntimeStateStore(state_path)
    message_id = str(uuid.uuid4())
    await state_store.save(RuntimeState(outbox=[], inbox=[], processed_incoming={message_id: "READ"}, counterparties={}))
    assert (await state_store.load()).processed_incoming == {message_id: "READ"}
    assert os.stat(state_path).st_mode & 0o777 == 0o600

    keys = IdentityKeys.generate()
    credentials = Credentials(
        "legacy", peer("AGENT", "@refresh.demo", "Refresh", keys), keys,
        access_token="old", refresh_token="refresh", access_token_expires_at="2020-01-01T00:00:00Z",
    )
    contexts: list[CredentialRefreshContext] = []

    async def refresh(context: CredentialRefreshContext):
        contexts.append(context)
        return RefreshedCredentials(access_token="new", refresh_token="rotated", access_token_expires_at="2030-01-01T00:00:00Z")

    runtime = Agent(
        token="placeholder",
        credential_path=str(tmp_path / "refresh-credentials.json"),
        runtime_state_store=MemoryRuntimeStateStore(),
        refresh_credentials=refresh,
    )
    runtime._credentials = credentials
    assert await runtime._refresh_credentials_if_needed("EXPIRING") is True
    assert runtime._credentials.access_token == "new"
    assert contexts[0].credentials.refresh_token == "refresh"


@pytest.mark.asyncio
async def test_activation_retries_exact_request_after_lost_response(tmp_path):
    credential_path = tmp_path / "activation-credentials.json"
    runtime_state_path = tmp_path / "activation-runtime.json"
    activation_token = "activation-token-that-is-long-enough-for-the-api"
    requests = []
    committed_response = None

    async def activation_request(_method, path, payload=None, *, authenticated=True):
        nonlocal committed_response
        assert path == "/v1/agents/activate"
        assert authenticated is False
        requests.append(dict(payload))
        if committed_response is None:
            committed_response = {
                "token": "activation-access-token",
                "accessToken": "activation-access-token",
                "refreshToken": "activation-refresh-token",
                "accessTokenExpiresAt": "2030-01-01T00:00:00.000Z",
                "peer": {
                    "id": "00000000-0000-4000-8000-000000000091",
                    "type": "AGENT",
                    "status": "ACTIVE",
                    "handle": "@activation.replay",
                    "displayName": "Activation Replay",
                    "publicDiscoverable": False,
                    "organizationDiscoverable": True,
                    "personalOwnerPeerId": "00000000-0000-4000-8000-000000000092",
                    "signingPublicKey": payload["signingPublicKey"],
                    "encryptionPublicKey": payload["encryptionPublicKey"],
                },
            }
            raise RuntimeError("connection reset after activation committed")
        return committed_response

    first = Agent(
        token=activation_token,
        credential_path=str(credential_path),
        runtime_state_path=str(runtime_state_path),
        supervision=False,
    )
    first._request = activation_request
    with pytest.raises(RuntimeError, match="connection reset after activation committed"):
        await first._activate()
    persisted = runtime_state_path.read_text()
    assert activation_token not in persisted
    assert json.loads(persisted)["pendingActivation"]["requestId"]

    restarted = Agent(
        token=activation_token,
        credential_path=str(credential_path),
        runtime_state_path=str(runtime_state_path),
        supervision=False,
    )
    restarted._runtime_state = await restarted._runtime_state_store.load()
    restarted._request = activation_request
    credentials = await restarted._activate()
    assert requests[1] == requests[0]
    assert credentials.access_token == "activation-access-token"
    assert credentials.keys.signing_public_key == requests[0]["signingPublicKey"]
    assert "pendingActivation" not in json.loads(runtime_state_path.read_text())


@pytest.mark.asyncio
async def test_default_refresh_rotates_expired_credentials_and_survives_restart(tmp_path, monkeypatch):
    credential_path = tmp_path / "automatic-refresh.json"
    keys = IdentityKeys.generate()
    store = FileCredentialStore(None, str(credential_path))
    await store.save(Credentials(
        "access-1", peer("AGENT", "@automatic.refresh", "Automatic refresh", keys), keys,
        access_token="access-1", refresh_token="refresh-1", access_token_expires_at="2020-01-01T00:00:00Z",
    ))
    received_refresh_tokens = []
    received_request_ids = []

    class FakeResponse:
        is_error = False

        def __init__(self, rotation):
            self.rotation = rotation

        def json(self):
            return {
                "accessToken": f"access-{self.rotation}",
                "refreshToken": f"refresh-{self.rotation}",
                "expiresAt": "2020-01-01T00:00:00Z",
            }

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, path, *, headers, json):
            assert path == "/v1/agent-runtime/session/refresh"
            assert headers == {"content-type": "application/json"}
            received_refresh_tokens.append(json["refreshToken"])
            received_request_ids.append(json["requestId"])
            return FakeResponse(len(received_refresh_tokens) + 1)

    monkeypatch.setattr(agent_module.httpx, "AsyncClient", FakeClient)

    first = Agent(credential_path=str(credential_path), base_url="https://api.atalk.test", supervision=False)
    first._credentials = await store.load()
    assert await first._refresh_credentials_if_needed("EXPIRING") is True
    assert (await store.load()).refresh_token == "refresh-2"

    restarted_store = FileCredentialStore(None, str(credential_path))
    restarted = Agent(credential_path=str(credential_path), base_url="https://api.atalk.test", supervision=False)
    restarted._credentials = await restarted_store.load()
    assert await restarted._refresh_credentials_if_needed("EXPIRING") is True
    assert received_refresh_tokens == ["refresh-1", "refresh-2"]
    assert all(uuid.UUID(request_id) for request_id in received_request_ids)
    assert received_request_ids[0] != received_request_ids[1]
    persisted = await restarted_store.load()
    assert persisted.access_token == "access-3"
    assert persisted.refresh_token == "refresh-3"


@pytest.mark.asyncio
async def test_default_refresh_reuses_persisted_request_after_lost_response(tmp_path, monkeypatch):
    credential_path = tmp_path / "lost-refresh.json"
    keys = IdentityKeys.generate()
    store = FileCredentialStore(None, str(credential_path))
    await store.save(Credentials(
        "lost-access", peer("AGENT", "@lost.refresh", "Lost refresh", keys), keys,
        access_token="lost-access", refresh_token="lost-refresh",
        access_token_expires_at="2020-01-01T00:00:00Z",
    ))
    request_ids = []

    class FakeResponse:
        is_error = False

        @staticmethod
        def json():
            return {
                "accessToken": "recovered-access",
                "refreshToken": "recovered-refresh",
                "expiresAt": "2030-01-01T00:00:00Z",
            }

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _path, *, headers, json):
            assert headers == {"content-type": "application/json"}
            request_ids.append(json["requestId"])
            if len(request_ids) == 1:
                raise agent_module.httpx.ReadError("response lost")
            return FakeResponse()

    monkeypatch.setattr(agent_module.httpx, "AsyncClient", FakeClient)
    first = Agent(credential_path=str(credential_path), base_url="https://api.atalk.test", supervision=False)
    first._credentials = await store.load()
    with pytest.raises(agent_module.httpx.ReadError, match="response lost"):
        await first._refresh_credentials_if_needed("EXPIRING")
    assert (await store.load()).refresh_request_id == request_ids[0]

    restarted = Agent(credential_path=str(credential_path), base_url="https://api.atalk.test", supervision=False)
    restarted._credentials = await store.load()
    assert await restarted._refresh_credentials_if_needed("EXPIRING") is True
    assert request_ids[1] == request_ids[0]
    persisted = await store.load()
    assert persisted.access_token == "recovered-access"
    assert persisted.refresh_token == "recovered-refresh"
    assert persisted.refresh_request_id is None


@pytest.mark.asyncio
async def test_default_refresh_rejects_an_expired_refresh_token_without_overwriting_credentials(tmp_path, monkeypatch):
    credential_path = tmp_path / "expired-refresh.json"
    keys = IdentityKeys.generate()
    credentials = Credentials(
        "expired-access", peer("AGENT", "@expired.refresh", "Expired refresh", keys), keys,
        access_token="expired-access", refresh_token="expired-refresh",
        access_token_expires_at="2020-01-01T00:00:00Z",
    )
    store = FileCredentialStore(None, str(credential_path))
    await store.save(credentials)

    class FakeResponse:
        is_error = True
        status_code = 401

        @staticmethod
        def json():
            return {"error": {
                "code": "INVALID_REFRESH_TOKEN",
                "message": "Agent credentials are invalid or expired",
            }}

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(agent_module.httpx, "AsyncClient", FakeClient)
    runtime = Agent(
        credential_path=str(credential_path), base_url="https://api.atalk.test", supervision=False,
    )
    runtime._credentials = await store.load()

    with pytest.raises(AgentError) as failure:
        await runtime._refresh_credentials_if_needed("EXPIRING")

    assert failure.value.code == "INVALID_REFRESH_TOKEN"
    assert await store.load() == credentials


@pytest.mark.asyncio
async def test_start_repairs_revoked_credentials_with_the_same_identity_keys(tmp_path):
    credential_path = tmp_path / "repair-credentials.json"
    keys = IdentityKeys.generate()
    previous = Credentials(
        "revoked-access", peer("AGENT", "@repair.keys", "Repair", keys), keys,
        access_token="revoked-access", refresh_token="revoked-refresh",
        access_token_expires_at="2020-01-01T00:00:00Z",
    )
    store = FileCredentialStore(None, str(credential_path))
    await store.save(previous)
    runtime = Agent(
        token="new-one-time-connection-code",
        credential_path=str(credential_path),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
    )
    refresh_attempts = 0
    activation_payloads = []

    async def refresh(_reason, *, force=False):
        nonlocal refresh_attempts
        refresh_attempts += 1
        if refresh_attempts == 1:
            raise AgentError("INVALID_REFRESH_TOKEN", "Agent credentials are invalid or expired")
        return False

    async def request(_method, path, payload=None, *, authenticated=True):
        assert path == "/v1/agents/activate"
        assert authenticated is False
        activation_payloads.append(dict(payload))
        return {
            "token": "repaired-access",
            "accessToken": "repaired-access",
            "refreshToken": "repaired-refresh",
            "accessTokenExpiresAt": "2030-01-01T00:00:00Z",
            "peer": {
                **previous.peer,
                "signingPublicKey": payload["signingPublicKey"],
                "encryptionPublicKey": payload["encryptionPublicKey"],
            },
        }

    async def connection_loop():
        runtime._ready.set()

    runtime._refresh_credentials_if_needed = refresh
    runtime._request = request
    runtime._connection_loop = connection_loop

    await runtime.start()

    assert len(activation_payloads) == 1
    assert activation_payloads[0]["activationToken"] == "new-one-time-connection-code"
    assert activation_payloads[0]["signingPublicKey"] == keys.signing_public_key
    assert activation_payloads[0]["encryptionPublicKey"] == keys.encryption_public_key
    persisted = await store.load()
    assert persisted.access_token == "repaired-access"
    assert persisted.refresh_token == "repaired-refresh"
    assert persisted.keys == keys


@pytest.mark.asyncio
async def test_file_credential_store_uses_owner_only_permissions(tmp_path):
    keys = IdentityKeys.generate()
    credentials = Credentials("s" * 48, peer("AGENT", "@stored.demo", "Stored", keys), keys)
    path = tmp_path / "nested" / "credentials.json"
    store = FileCredentialStore("activation-token-placeholder", str(path))
    await store.save(credentials)
    assert await store.load() == credentials
    assert os.stat(path).st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_reopens_explicit_path_without_activation_token(tmp_path):
    path = tmp_path / "missing.json"
    runtime = Agent(credential_path=str(path))
    assert runtime.connected is False
    assert runtime.peer is None
    with pytest.raises(AgentError, match="ACTIVATION_REQUIRED"):
        await runtime.start()


def test_file_store_requires_token_or_path():
    with pytest.raises(ValueError, match="activation token or an explicit credential path"):
        FileCredentialStore()


@pytest.mark.asyncio
async def test_attachment_can_be_saved_with_private_permissions(tmp_path):
    async def download():
        return b"image-bytes"

    attachment = Attachment(
        descriptor={"id": str(uuid.uuid4()), "name": "sample.png", "mimeType": "image/png"},
        _download=download,
    )
    path = await attachment.save_to(tmp_path / "inbox" / "sample.png")
    assert path.read_bytes() == b"image-bytes"
    assert os.stat(path).st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_file_attachment_streams_v2_with_recipient_name_and_progress(tmp_path):
    agent_keys = IdentityKeys.generate()
    recipient_keys = IdentityKeys.generate()
    agent_peer = peer("AGENT", "@files.demo", "Files", agent_keys)
    recipient = peer("HUMAN", "@recipient.demo", "Recipient", recipient_keys)
    runtime = FakeAgent(
        Credentials("s" * 48, agent_peer, agent_keys),
        {recipient["id"]: recipient},
        {recipient["handle"]: recipient},
    )
    source = tmp_path / "opaque-source.bin"
    source.write_bytes(b"invoice-42")
    uploaded = {}

    async def upload(_recipient_id, attachment_id, ciphertext, **_kwargs):
        uploaded[attachment_id] = ciphertext

    runtime._upload_attachment = upload
    progress = []
    sent = await runtime.send_attachment_file_with_details(
        recipient["handle"], source, "application/pdf", progress=lambda sent, total: progress.append((sent, total)),
        name="invoice.pdf",
    )
    envelope = next(item for item in runtime._runtime_state.outbox if item["message_id"] == sent.message_id)
    payload = decode_attachment_message(decrypt_text(
        envelope=envelope,
        sender_signing_public_key=agent_peer["signingPublicKey"],
        sender_encryption_public_key=agent_peer["encryptionPublicKey"],
        recipient_encryption_secret_key=recipient_keys.encryption_secret_key,
    ))
    descriptor = payload["attachment"]
    assert descriptor["version"] == 2
    assert descriptor["name"] == "invoice.pdf"
    assert decrypt_attachment_chunk(uploaded[descriptor["id"]], descriptor, 0) == b"invoice-42"
    assert progress == [(10, 10)]
