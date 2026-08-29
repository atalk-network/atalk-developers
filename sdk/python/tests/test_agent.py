import json
import os
import uuid

import pytest

from atalk import Agent, Credentials, FileCredentialStore
from atalk.protocol import IdentityKeys, decrypt_text, encrypt_text


class FakeSocket:
    def __init__(self):
        self.frames = []

    async def send(self, value):
        self.frames.append(json.loads(value))


class FakeAgent(Agent):
    def __init__(self, credentials, peers, recipient):
        super().__init__(token="activation-token-placeholder", supervision=True)
        self._credentials = credentials
        self._peers = peers
        self._recipient = recipient
        self._socket = FakeSocket()
        self._ready.set()

    async def _request(self, method, path, payload=None, *, authenticated=True):
        if path == "/v1/messages/authorize":
            return {"recipient": self._recipient[payload["recipientHandle"]]}
        if path.startswith("/v1/peers/"):
            return self._peers[path.split("/")[-2]]
        raise AssertionError(f"Unexpected request: {method} {path}")


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

    seen = []

    @runtime.on_message
    async def intervene(message):
        seen.append(message)
        assert message.is_supervisor is True
        await message.relay("Move delivery to 09:00")

    intervention = encrypt_text(
        message_id=str(uuid.uuid4()),
        conversation_id=conversation_id,
        sender_peer_id=supervisor["id"],
        recipient_peer_id=agent_peer["id"],
        timestamp="2026-08-29T12:00:00.000Z",
        plaintext="Please intervene",
        sender_signing_secret_key=supervisor_keys.signing_secret_key,
        sender_encryption_secret_key=supervisor_keys.encryption_secret_key,
        recipient_encryption_public_key=agent_keys.encryption_public_key,
    )
    await runtime._handle_frame({"kind": "MESSAGE", "envelope": intervention})
    assert len(seen) == 1
    relayed = next(
        frame["envelope"] for frame in runtime._socket.frames[2:]
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
async def test_file_credential_store_uses_owner_only_permissions(tmp_path):
    keys = IdentityKeys.generate()
    credentials = Credentials("s" * 48, peer("AGENT", "@stored.demo", "Stored", keys), keys)
    path = tmp_path / "nested" / "credentials.json"
    store = FileCredentialStore("activation-token-placeholder", str(path))
    await store.save(credentials)
    assert await store.load() == credentials
    assert os.stat(path).st_mode & 0o777 == 0o600
