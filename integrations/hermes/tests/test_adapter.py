from __future__ import annotations

import sys
import types
import uuid
from dataclasses import dataclass
from enum import Enum

import pytest


def _install_hermes_contract_stubs() -> None:
    gateway = types.ModuleType("gateway")
    config = types.ModuleType("gateway.config")
    platforms = types.ModuleType("gateway.platforms")
    base = types.ModuleType("gateway.platforms.base")

    class Platform(str):
        pass

    @dataclass
    class PlatformConfig:
        extra: dict | None = None

    class MessageType(Enum):
        TEXT = "text"
        PHOTO = "photo"
        VIDEO = "video"
        VOICE = "voice"
        DOCUMENT = "document"

    @dataclass
    class SendResult:
        success: bool
        message_id: str | None = None
        error: str | None = None

    @dataclass
    class MessageEvent:
        text: str
        message_type: MessageType
        user_id: str
        user_name: str
        source: object
        message_id: str
        media_urls: list[str]
        media_types: list[str]
        media_text_inlined: list[bool]

    class BasePlatformAdapter:
        def __init__(self, config_value, platform):
            self.config = config_value
            self.platform = platform

        def build_source(self, **values):
            return values

        async def handle_message(self, _event):
            return None

        def _mark_connected(self):
            return None

        def _mark_disconnected(self):
            return None

    config.Platform = Platform
    config.PlatformConfig = PlatformConfig
    base.BasePlatformAdapter = BasePlatformAdapter
    base.MessageEvent = MessageEvent
    base.MessageType = MessageType
    base.SendResult = SendResult
    sys.modules.update({
        "gateway": gateway,
        "gateway.config": config,
        "gateway.platforms": platforms,
        "gateway.platforms.base": base,
    })


_install_hermes_contract_stubs()

from atalk_hermes.adapter import (  # noqa: E402
    AtalkAdapter,
    _message_type,
    _render_workroom_event,
    _response_mentions,
    _should_dispatch_workroom_event,
    _should_relay_message,
    _stable_uuid,
)
from atalk_hermes import register  # noqa: E402
from atalk_hermes.tools import clear_active_adapter, set_active_adapter  # noqa: E402


def test_workroom_helpers_preserve_structured_routing_and_plan_context():
    value = _stable_uuid("event:file")
    assert str(uuid.UUID(value)) == value
    assert value == _stable_uuid("event:file")
    rendered_plan = _render_workroom_event({
        "version": 1,
        "kind": "plan",
        "summary": "Prepare report",
        "steps": [
            {"id": "mine", "status": "executing", "title": "Compare sources"},
            {"id": "other", "status": "executing", "title": "Contact customer"},
            {"id": "done", "status": "completed", "title": "Old work"},
        ],
    }, {
        "directedToMe": True,
        "directMentions": [],
        "assignedSteps": [{"id": "mine", "status": "executing", "title": "Compare sources"}],
    })
    assert "Your executable assigned steps" in rendered_plan
    assert "Compare sources" in rendered_plan
    assert "Contact customer" not in rendered_plan
    assert "Old work" not in rendered_plan
    directed = {"directedToMe": True, "routing": {"directedToMe": True}}
    assert _should_dispatch_workroom_event(directed) is True
    assert _response_mentions({
        "actor": {
            "id": "11111111-1111-4111-8111-111111111111",
            "handle": "@requester.agent",
            "type": "AGENT",
        },
    }) == [{
        "peerId": "11111111-1111-4111-8111-111111111111",
        "handle": "@requester.agent",
        "peerType": "AGENT",
        "intent": "direct",
    }]
    assert _message_type("image/png").value == "photo"
    assert _message_type("video/mp4").value == "video"
    assert _message_type("audio/webm").value == "voice"
    assert _message_type("application/pdf").value == "document"

    first_agent_event = {
        "directedToMe": True,
        "routing": {"directedToMe": True, "directMentions": [{"peerId": "agent-one"}], "assignedSteps": []},
        "content": {"kind": "message", "body": "Only agent one", "mentions": [{"peerId": "agent-one"}]},
    }
    second_agent_view = {
        **first_agent_event,
        "directedToMe": False,
        "routing": {"directedToMe": False, "directMentions": [], "assignedSteps": []},
    }
    ambiguous_general_message = {
        "directedToMe": False,
        "routing": {"directedToMe": False, "directMentions": [], "assignedSteps": []},
        "content": {"kind": "message", "body": "@agent-one in plain text", "mentions": []},
    }
    legacy_top_level_only = {**first_agent_event}
    legacy_top_level_only.pop("routing")
    assert _should_dispatch_workroom_event(first_agent_event) is True
    assert _should_dispatch_workroom_event(second_agent_view) is False
    assert _should_dispatch_workroom_event(ambiguous_general_message) is False
    assert _should_dispatch_workroom_event(legacy_top_level_only) is False


def test_direct_message_responses_obey_sdk_routing():
    fallback_reply = types.SimpleNamespace(
        routing={"mode": "REPLY", "targetHandle": "@owner.test"},
        is_supervisor=True,
        is_mentioned=False,
    )
    supervised_relay = types.SimpleNamespace(
        routing={"mode": "RELAY", "targetHandle": "@counterparty.test"},
        is_supervisor=True,
        is_mentioned=False,
    )
    incomplete_relay = types.SimpleNamespace(
        routing={"mode": "RELAY", "targetHandle": ""},
        is_supervisor=True,
        is_mentioned=False,
    )
    assert _should_relay_message(fallback_reply) is False
    assert _should_relay_message(supervised_relay) is True
    assert _should_relay_message(incomplete_relay) is False


@pytest.mark.asyncio
async def test_workroom_reply_uses_mandated_publication_and_mentions_the_requester():
    captured = []

    class Workrooms:
        async def get(self, _workroom_id, _after, _limit):
            return {
                "members": [{"membership": {"peerId": "11111111-1111-4111-8111-111111111111"}}],
            }

        async def publish_mandated(self, request):
            captured.append(request)
            return {
                "status": "executed",
                "value": {"event": {"eventId": "22222222-2222-4222-8222-222222222222"}},
            }

    adapter = AtalkAdapter.__new__(AtalkAdapter)
    adapter._agent = types.SimpleNamespace(workrooms=Workrooms())
    chat_id = "workroom:33333333-3333-4333-8333-333333333333:44444444-4444-4444-8444-444444444444"
    adapter._latest_workroom_event = {
        chat_id: {
            "event": {"eventId": "55555555-5555-4555-8555-555555555555"},
            "actor": {
                "id": "66666666-6666-4666-8666-666666666666",
                "handle": "@owner.test",
                "type": "HUMAN",
            },
        },
    }

    result = await adapter.send(chat_id, "Draft ready")

    assert result.success is True
    assert captured[0]["payload"]["kind"] == "message"
    assert captured[0]["payload"]["replyToEventId"] == "55555555-5555-4555-8555-555555555555"
    assert captured[0]["payload"]["mentions"] == [{
        "peerId": "66666666-6666-4666-8666-666666666666",
        "handle": "@owner.test",
        "peerType": "HUMAN",
        "intent": "direct",
    }]


@pytest.mark.asyncio
async def test_hermes_registers_native_task_tools_and_plan_uses_mandated_path():
    registered: dict[str, dict] = {}

    class Context:
        def register_tool(self, **kwargs):
            registered[kwargs["name"]] = kwargs

        def register_platform(self, **_kwargs):
            return None

    register(Context())
    assert {
        "atalk_task_list", "atalk_task_open", "atalk_task_message", "atalk_task_activity",
        "atalk_task_plan", "atalk_task_deliverable", "atalk_task_submit_file",
    }.issubset(registered)
    assert all(item["is_async"] for item in registered.values())

    captured = []
    task = {
        "workroom": {"id": "11111111-1111-4111-8111-111111111111", "status": "executing"},
        "descriptor": {"version": 1, "objective": "Prepare brief", "dataCategories": []},
        "membership": {"role": "worker", "joinedAt": "2026-09-03T00:00:00Z"},
        "members": [{
            "membership": {"peerId": "22222222-2222-4222-8222-222222222222", "role": "worker"},
            "peer": {"id": "22222222-2222-4222-8222-222222222222", "handle": "@analysis.agent", "type": "AGENT"},
        }],
        "threads": [], "latestMandates": [], "approvals": [],
    }

    class Workrooms:
        async def get(self, *_args):
            return task

        async def publish_mandated(self, request):
            captured.append(request)
            return {"status": "requires_approval", "requestIds": ["approval-id"]}

    adapter = types.SimpleNamespace(_agent=types.SimpleNamespace(workrooms=Workrooms()))
    set_active_adapter(adapter)
    try:
        result = await registered["atalk_task_plan"]["handler"]({
            "kind": "plan",
            "workroomId": "11111111-1111-4111-8111-111111111111",
            "threadId": "33333333-3333-4333-8333-333333333333",
            "planVersion": 1,
            "summary": "Prepare",
            "steps": [{
                "id": "draft", "title": "Draft", "status": "executing",
                "assignedHandles": ["@analysis.agent"],
            }],
        })
    finally:
        clear_active_adapter(adapter)

    assert '"requires_approval"' in result
    assert captured[0]["payload"]["kind"] == "plan"
    assert captured[0]["payload"]["steps"][0]["assignedPeerIds"] == [
        "22222222-2222-4222-8222-222222222222",
    ]


@pytest.mark.asyncio
async def test_workroom_approval_wait_retries_but_terminal_denial_does_not():
    task = {"members": []}

    class Workrooms:
        async def get(self, *_args):
            return task

        async def publish_mandated(self, _request):
            return {"status": "requires_approval", "requestIds": ["approval-id"]}

    adapter = AtalkAdapter.__new__(AtalkAdapter)
    adapter._agent = types.SimpleNamespace(workrooms=Workrooms())
    adapter._latest_workroom_event = {}
    chat_id = "workroom:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222"
    with pytest.raises(RuntimeError, match="requires_approval"):
        await adapter.send(chat_id, "Needs consent")

    async def denied(_request):
        return {"status": "denied", "code": "MANDATE_ENDED"}

    adapter._agent.workrooms.publish_mandated = denied
    result = await adapter.send(chat_id, "Too late")
    assert result.success is False
    assert "denied" in result.error


@pytest.mark.asyncio
async def test_native_file_tool_preserves_voice_mime_and_returns_artifact_ids(tmp_path):
    registered: dict[str, dict] = {}

    class Context:
        def register_tool(self, **kwargs):
            registered[kwargs["name"]] = kwargs

        def register_platform(self, **_kwargs):
            return None

    register(Context())
    voice = tmp_path / "voice.webm"
    voice.write_bytes(b"voice")
    captured = []

    class Workrooms:
        async def get(self, *_args):
            return {
                "workroom": {"id": "11111111-1111-4111-8111-111111111111", "status": "executing"},
                "descriptor": {"version": 1, "objective": "Transcribe voice"},
                "membership": {"role": "worker", "joinedAt": "2026-09-03T00:00:00Z"},
                "members": [], "threads": [], "latestMandates": [], "approvals": [],
            }

        async def submit_file_mandated(self, request):
            captured.append(request)
            return {"status": "executed", "value": {
                "artifactId": "22222222-2222-4222-8222-222222222222",
                "artifactVersion": 1,
                "artifactVersionId": "33333333-3333-4333-8333-333333333333",
            }}

    adapter = types.SimpleNamespace(_agent=types.SimpleNamespace(workrooms=Workrooms()))
    set_active_adapter(adapter)
    try:
        result = await registered["atalk_task_submit_file"]["handler"]({
            "workroomId": "11111111-1111-4111-8111-111111111111",
            "threadId": "44444444-4444-4444-8444-444444444444",
            "filePath": "voice.webm",
            "mimeType": "audio/webm",
        }, cwd=str(tmp_path))
        with pytest.raises(ValueError, match="active Hermes workspace"):
            await registered["atalk_task_submit_file"]["handler"]({
                "workroomId": "11111111-1111-4111-8111-111111111111",
                "threadId": "44444444-4444-4444-8444-444444444444",
                "filePath": __file__,
            }, cwd=str(tmp_path))
    finally:
        clear_active_adapter(adapter)

    assert '"artifactVersionId":"33333333-3333-4333-8333-333333333333"' in result
    assert captured[0]["filePath"] == voice.resolve()
    assert captured[0]["mimeType"] == "audio/webm"
