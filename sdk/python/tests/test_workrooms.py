from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from atalk.agent import RuntimeState
from atalk.workrooms import (
    WorkroomClient,
    _approval_request_id,
    _content_directed_to,
    _evaluate_mandate,
    _routing_context,
    _validate_routing_bindings,
    _workroom_stop_reason,
    default_workroom_action,
)


def _mandate():
    return {
        "mandateId": "11111111-1111-4111-8111-111111111111",
        "actorPeerId": "22222222-2222-4222-8222-222222222222",
        "allowedParticipantPeerIds": [
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
        ],
        "validFrom": "2020-01-01T00:00:00+00:00",
        "validUntil": "2099-01-01T00:00:00+00:00",
        "delegation": {
            "allowed": True,
            "maxDepth": 1,
            "allowedDelegatePeerIds": ["33333333-3333-4333-8333-333333333333"],
            "requirePrincipalApproval": False,
        },
        "allowedActions": ["message.send"],
        "allowedTools": [], "allowedData": [], "spendLimits": [], "approvalThresholds": [],
        "volumeLimits": {"maxMessages": 1, "custom": {"tokens": 10}},
        "endConditions": [{"id": "completed", "type": "workroom_completed"}],
    }


def _request():
    return {
        "mandateId": "11111111-1111-4111-8111-111111111111",
        "action": "message.send", "participantPeerIds": [], "dataAccesses": [],
        "delegationDepth": 0, "volumeUsed": {},
        "volumeDelta": {"messages": 1, "custom": {}}, "metEndConditionIds": [],
    }


def test_python_guard_enforces_end_delegation_and_volume_limits():
    mandate = _mandate()
    request = _request()
    actor = mandate["actorPeerId"]
    assert _evaluate_mandate(mandate, request, actor, []) == {"status": "permitted"}

    ended = deepcopy(request)
    ended["metEndConditionIds"] = ["completed"]
    assert _evaluate_mandate(mandate, ended, actor, [])["code"] == "MANDATE_ENDED"

    exhausted = deepcopy(request)
    exhausted["volumeUsed"] = {"messages": 1}
    assert _evaluate_mandate(mandate, exhausted, actor, [])["code"] == "VOLUME_LIMIT_EXCEEDED"

    delegated = deepcopy(request)
    delegated["delegationDepth"] = 2
    assert _evaluate_mandate(
        mandate, delegated, "33333333-3333-4333-8333-333333333333", [],
    )["code"] == "DELEGATION_DEPTH_EXCEEDED"


def test_python_guard_enforces_web_domain_allowlist():
    mandate = _mandate()
    mandate["allowedTools"] = [{
        "tool": "web.search", "actions": ["query"], "audience": "example.com, *.data.gov",
    }]
    request = _request()
    request["tool"] = {
        "tool": "web.search", "action": "query", "audience": "https://reports.data.gov/public",
    }
    assert _evaluate_mandate(mandate, request, mandate["actorPeerId"], []) == {"status": "permitted"}

    request["tool"]["audience"] = "https://unlisted.example.net"
    assert _evaluate_mandate(mandate, request, mandate["actorPeerId"], [])["code"] == "TOOL_DENIED"
    del request["tool"]["audience"]
    assert _evaluate_mandate(mandate, request, mandate["actorPeerId"], [])["code"] == "TOOL_DENIED"


def test_task_action_vocabulary_and_plan_assignment_routing():
    agent_id = "22222222-2222-4222-8222-222222222222"
    other_id = "33333333-3333-4333-8333-333333333333"
    plan = {
        "kind": "plan",
        "steps": [
            {"id": "mine-now", "title": "Do now", "status": "executing", "assignedPeerIds": [agent_id]},
            {"id": "mine-done", "title": "Already done", "status": "completed", "assignedPeerIds": [agent_id]},
            {"id": "theirs", "title": "Other agent", "status": "executing", "assignedPeerIds": [other_id]},
        ],
    }
    assert _content_directed_to(plan, agent_id) is True
    routing = _routing_context(plan, agent_id, other_id)
    assert routing["directedToMe"] is True
    assert [step["id"] for step in routing["assignedSteps"]] == ["mine-now"]
    assert routing["directMentions"] == []
    assert _content_directed_to(plan, agent_id, agent_id) is False
    assert _routing_context(plan, agent_id, agent_id)["assignedSteps"] == []
    fyi = {
        "kind": "message",
        "mentions": [{"peerId": agent_id, "intent": "fyi"}],
    }
    assert _content_directed_to(fyi, agent_id, other_id) is False
    assert default_workroom_action("message") == "message.send"
    assert default_workroom_action("plan") == "plan.update"
    assert default_workroom_action("artifact_version") == "file.create"
    assert default_workroom_action("deliverable") == "deliverable.submit"
    with pytest.raises(ValueError, match="MUST_BE_DERIVED"):
        default_workroom_action("cost")
    with pytest.raises(ValueError, match="CREATED_BY_THE_MANDATE_GUARD"):
        default_workroom_action("approval_request")
    assert _workroom_stop_reason({"status": "completed"}) == "completed"
    assert _workroom_stop_reason({"status": "executing", "deadline": "2020-01-01T00:00:00Z"}) == "deadline"
    assert _workroom_stop_reason({"status": "executing", "deadline": "2099-01-01T00:00:00Z"}) is None


@pytest.mark.asyncio
async def test_poll_only_invokes_explicit_target_with_two_agents_and_never_auto_targets_singleton():
    first_id = "22222222-2222-4222-8222-222222222222"
    second_id = "33333333-3333-4333-8333-333333333333"
    general = {
        "sequence": 1,
        "event": {"eventId": "44444444-4444-4444-8444-444444444441"},
        "content": {
            "kind": "message", "body": "@worker.one is plain text only", "mentions": [],
        },
        "directedToMe": False,
    }
    directed = {
        "sequence": 2,
        "event": {"eventId": "44444444-4444-4444-8444-444444444442"},
        "content": {
            "kind": "message", "body": "Only worker one acts",
            "mentions": [{"peerId": first_id, "handle": "@worker.one", "peerType": "AGENT", "intent": "direct"}],
        },
        "directedToMe": True,
    }

    def client_with(events):
        state = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})

        async def mutate(mutator):
            mutator(state)

        agent = SimpleNamespace(_runtime_state=state, _mutate_runtime_state=mutate)
        client = WorkroomClient(agent)
        client._read_event_page = AsyncMock(return_value={"events": events, "nextAfterSequence": None})
        return client, state

    first, first_state = client_with([general, directed])
    first_handler = AsyncMock()
    assert await first.poll("11111111-1111-4111-8111-111111111111", first_handler) == 2
    first_handler.assert_awaited_once_with(directed)
    assert first_state.workroom_cursors["11111111-1111-4111-8111-111111111111"] == 2

    second_view = deepcopy(directed)
    second_view["directedToMe"] = False
    second, second_state = client_with([general, second_view])
    second_handler = AsyncMock()
    assert await second.poll("11111111-1111-4111-8111-111111111111", second_handler) == 2
    second_handler.assert_not_awaited()
    assert second_state.workroom_cursors["11111111-1111-4111-8111-111111111111"] == 2

    singleton, singleton_state = client_with([general])
    singleton_handler = AsyncMock()
    assert await singleton.poll("11111111-1111-4111-8111-111111111111", singleton_handler) == 1
    singleton_handler.assert_not_awaited()
    assert singleton_state.workroom_cursors["11111111-1111-4111-8111-111111111111"] == 1

    assert _content_directed_to(general["content"], first_id) is False
    assert _content_directed_to(directed["content"], first_id) is True
    assert _content_directed_to(directed["content"], second_id) is False


@pytest.mark.asyncio
async def test_poll_gives_agent_only_its_executable_plan_steps_but_audit_keeps_full_plan():
    agent_id = "22222222-2222-4222-8222-222222222222"
    other_id = "33333333-3333-4333-8333-333333333333"
    event = {
        "sequence": 1,
        "event": {"eventId": "44444444-4444-4444-8444-444444444444"},
        "content": {
            "version": 1,
            "kind": "plan",
            "summary": "Prepare report",
            "steps": [
                {"id": "mine", "title": "Compare sources", "status": "executing", "assignedPeerIds": [agent_id]},
                {"id": "other", "title": "Call customer", "status": "executing", "assignedPeerIds": [other_id]},
                {"id": "done", "title": "Old work", "status": "completed", "assignedPeerIds": [agent_id]},
            ],
        },
        "routing": {
            "directedToMe": True,
            "directMentions": [],
            "assignedSteps": [
                {"id": "mine", "title": "Compare sources", "status": "executing", "assignedPeerIds": [agent_id]},
            ],
        },
        "directedToMe": True,
    }
    state = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})

    async def mutate(mutator):
        mutator(state)

    client = WorkroomClient(SimpleNamespace(_runtime_state=state, _mutate_runtime_state=mutate))
    client._read_event_page = AsyncMock(return_value={"events": [event], "nextAfterSequence": None})
    handler = AsyncMock()

    await client.poll("11111111-1111-4111-8111-111111111111", handler)

    autonomous_event = handler.await_args.args[0]
    assert [step["id"] for step in autonomous_event["content"]["steps"]] == ["mine"]
    assert [step["id"] for step in event["content"]["steps"]] == ["mine", "other", "done"]
    audit = await client.read_audit_events("11111111-1111-4111-8111-111111111111")
    assert [step["id"] for step in audit["events"][0]["content"]["steps"]] == ["mine", "other", "done"]


def test_routing_bindings_require_exact_active_identity_and_reject_self_direction():
    actor_id = "22222222-2222-4222-8222-222222222222"
    target_id = "33333333-3333-4333-8333-333333333333"
    detail = {
        "members": [
            {
                "membership": {"peerId": actor_id, "peerType": "AGENT", "role": "worker"},
                "peer": {"id": actor_id, "handle": "@author.agent", "type": "AGENT", "status": "ACTIVE"},
            },
            {
                "membership": {"peerId": target_id, "peerType": "AGENT", "role": "worker"},
                "peer": {"id": target_id, "handle": "@worker.agent", "type": "AGENT", "status": "ACTIVE"},
            },
        ],
    }
    mention = {
        "peerId": target_id, "handle": "@worker.agent", "peerType": "AGENT", "intent": "direct",
    }
    _validate_routing_bindings({"kind": "message", "mentions": [mention]}, detail, actor_id)

    inconsistent_detail = deepcopy(detail)
    inconsistent_detail["members"][1]["membership"]["peerType"] = "HUMAN"
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_MEMBER_INVALID"):
        _validate_routing_bindings({"kind": "message", "mentions": []}, inconsistent_detail, actor_id)

    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        _validate_routing_bindings(
            {"kind": "message", "mentions": [{**mention, "handle": "@author.agent"}]}, detail, actor_id,
        )
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        _validate_routing_bindings(
            {"kind": "message", "mentions": [{**mention, "peerType": "HUMAN"}]}, detail, actor_id,
        )
    with pytest.raises(ValueError, match="WORKROOM_SELF_DIRECTION_FORBIDDEN"):
        _validate_routing_bindings({
            "kind": "message",
            "mentions": [{
                "peerId": actor_id, "handle": "@author.agent", "peerType": "AGENT", "intent": "direct",
            }],
        }, detail, actor_id)
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_DUPLICATE_TARGET"):
        _validate_routing_bindings({"kind": "message", "mentions": [mention, mention]}, detail, actor_id)

    inactive = deepcopy(detail)
    inactive["members"][1]["membership"]["leftAt"] = "2026-09-03T00:00:00Z"
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_TARGET_NOT_ACTIVE"):
        _validate_routing_bindings({"kind": "message", "mentions": [mention]}, inactive, actor_id)

    with pytest.raises(ValueError, match="WORKROOM_ROUTING_TARGET_NOT_ACTIVE"):
        _validate_routing_bindings({
            "kind": "plan",
            "steps": [{
                "id": "stale", "title": "Stale", "status": "executing",
                "assignedPeerIds": ["44444444-4444-4444-8444-444444444444"],
            }],
        }, detail, actor_id)
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_DUPLICATE_TARGET"):
        _validate_routing_bindings({
            "kind": "plan",
            "steps": [{
                "id": "duplicate", "title": "Duplicate", "status": "executing",
                "assignedPeerIds": [target_id, target_id],
            }],
        }, detail, actor_id)


@pytest.mark.asyncio
async def test_publish_and_decrypt_both_enforce_routing_bindings(monkeypatch):
    actor_id = "22222222-2222-4222-8222-222222222222"
    target_id = "33333333-3333-4333-8333-333333333333"
    thread_id = "44444444-4444-4444-8444-444444444444"
    credentials = SimpleNamespace(
        peer={"id": actor_id},
        keys=SimpleNamespace(encryption_secret_key="enc-secret", signing_secret_key="sign-secret"),
    )
    detail = {
        "workroom": {"currentKeyEpoch": 1},
        "membership": {"role": "worker"},
        "members": [
            {
                "membership": {"peerId": actor_id, "peerType": "AGENT", "role": "worker"},
                "peer": {
                    "id": actor_id, "handle": "@author.agent", "type": "AGENT", "status": "ACTIVE",
                    "encryptionPublicKey": "actor-enc", "signingPublicKey": "actor-sign",
                },
            },
            {
                "membership": {"peerId": target_id, "peerType": "AGENT", "role": "worker"},
                "peer": {
                    "id": target_id, "handle": "@worker.agent", "type": "AGENT", "status": "ACTIVE",
                    "encryptionPublicKey": "target-enc", "signingPublicKey": "target-sign",
                },
            },
        ],
    }
    agent = SimpleNamespace(_require_credentials=lambda: credentials, _request=AsyncMock())
    client = WorkroomClient(agent)
    client.get = AsyncMock(return_value=detail)
    forged = {
        "version": 1, "kind": "message", "threadId": thread_id, "body": "Do work",
        "mentions": [{
            "peerId": target_id, "handle": "@author.agent", "peerType": "AGENT", "intent": "direct",
        }],
    }
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        await client.publish("11111111-1111-4111-8111-111111111111", thread_id, forged)

    recipient_credentials = SimpleNamespace(
        peer={"id": target_id},
        keys=SimpleNamespace(encryption_secret_key="target-secret"),
    )
    recipient = WorkroomClient(SimpleNamespace(
        _require_credentials=lambda: recipient_credentials, _request=AsyncMock(),
    ))
    monkeypatch.setattr("atalk.workrooms.decrypt_workroom_payload", lambda **_kwargs: forged)
    record = {"event": {
        "eventId": "55555555-5555-4555-8555-555555555555",
        "threadId": thread_id, "actorPeerId": actor_id, "kind": "message", "envelope": {},
    }}
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        await recipient._decrypt_event(record, detail)

    valid = deepcopy(forged)
    valid["mentions"][0]["handle"] = "@worker.agent"
    monkeypatch.setattr("atalk.workrooms.decrypt_workroom_payload", lambda **_kwargs: valid)
    decrypted = await recipient._decrypt_event(record, detail)
    assert decrypted["directedToMe"] is True
    assert decrypted["routing"] == {
        "directedToMe": True,
        "directMentions": [valid["mentions"][0]],
        "assignedSteps": [],
    }


def test_approval_id_binds_exact_effect_but_normalizes_participant_order():
    signed = {"mandate": {"mandateId": "11111111-1111-4111-8111-111111111111", "revision": 2}}
    request = {
        "operationId": "44444444-4444-4444-8444-444444444444",
        "action": "purchase.create",
        "rationale": "Buy the approved report",
        "summary": "Purchase vendor report",
        "target": {"type": "vendor", "label": "Example", "reference": "order-7"},
        "effect": "Charge USD 25 and share the report in this Task",
        "financialImpact": {"currency": "USD", "amountMinor": 2500, "kind": "exact"},
        "dataCategories": ["vendor-report"],
        "participantPeerIds": [
            "33333333-3333-4333-8333-333333333333",
            "22222222-2222-4222-8222-222222222222",
        ],
        "tool": {"tool": "vendor.api", "action": "purchase", "audience": "vendor.example"},
        "dataAccesses": [],
        "spend": {"currency": "USD", "amountMinor": 2500},
    }
    request_id = _approval_request_id(request, signed, "owner-review")
    assert request_id == "0f580381-4e35-404b-b859-b1efda543a1c"
    reordered = {**request, "participantPeerIds": list(reversed(request["participantPeerIds"]))}
    assert _approval_request_id(reordered, signed, "owner-review") == request_id
    assert _approval_request_id({**request, "effect": "Charge USD 50"}, signed, "owner-review") != request_id
    assert _approval_request_id({
        **request,
        "financialImpact": {"currency": "USD", "amountMinor": 5000, "kind": "exact"},
        "spend": {"currency": "USD", "amountMinor": 5000},
    }, signed, "owner-review") != request_id
