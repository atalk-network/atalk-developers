from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from atalk.agent import MemoryRuntimeStateStore, RuntimeState
from atalk.protocol import hash_b64url_payload
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


def _raw_poll_record(view):
    actor_id = "99999999-9999-4999-8999-999999999999"
    workroom_id = "11111111-1111-4111-8111-111111111111"
    created_at = "2026-09-04T12:00:00.000Z"
    return {
        "sequence": view["sequence"],
        "event": {
            "eventId": view["event"]["eventId"],
            "workroomId": workroom_id,
            "threadId": "77777777-7777-4777-8777-777777777777",
            "actorPeerId": actor_id,
            "kind": view["content"]["kind"],
            "envelope": {
                "envelopeId": view["event"]["eventId"],
                "workroomId": workroom_id,
                "senderPeerId": actor_id,
                "createdAt": created_at,
                "cipherSuite": "ATALK_SEALED_BOX_V1",
            },
            "idempotencyKey": f"event-{view['event']['eventId']}",
            "createdAt": created_at,
        },
        "membershipSnapshot": [{
            "peerId": actor_id,
            "peerType": "HUMAN",
            "role": "owner",
            "handle": "@task.owner",
            "signingPublicKey": "signing-key",
            "encryptionPublicKey": "encryption-key",
        }],
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


@pytest.mark.asyncio
async def test_current_observer_role_denies_mandated_external_effect():
    credentials = SimpleNamespace(peer={"id": "22222222-2222-4222-8222-222222222222"})
    agent = SimpleNamespace(_require_credentials=lambda: credentials)
    client = WorkroomClient(agent)
    client.get = AsyncMock(return_value={
        "workroom": {"status": "executing"},
        "membership": {"role": "observer"},
    })
    effect = AsyncMock(return_value={"value": "must not run"})

    result = await client.execute_mandated_action({
        "workroomId": "11111111-1111-4111-8111-111111111111",
    }, effect)

    assert result == {
        "status": "denied", "code": "MANDATE_MISMATCH", "detail": "observer role is read-only",
    }
    effect.assert_not_awaited()


@pytest.mark.asyncio
async def test_mandate_guard_denies_observer_or_removed_mandate_parties(monkeypatch):
    actor_id = "22222222-2222-4222-8222-222222222222"
    principal_id = "33333333-3333-4333-8333-333333333333"
    issuer_id = "44444444-4444-4444-8444-444444444444"
    credentials = SimpleNamespace(peer={"id": actor_id})
    signed = {"mandate": {
        "actorPeerId": actor_id,
        "principalPeerId": principal_id,
        "issuedByPeerId": issuer_id,
    }}
    monkeypatch.setattr("atalk.workrooms._open_mandate", lambda *_args: signed)
    parties = {"actor": actor_id, "principal": principal_id, "issuer": issuer_id}

    for party, peer_id in parties.items():
        for state in ("observer", "removed"):
            base_members = [
                {"membership": {"peerId": actor_id, "role": "contributor"}},
                {"membership": {"peerId": principal_id, "role": "owner"}},
                {"membership": {"peerId": issuer_id, "role": "supervisor"}},
            ]
            members = ([
                {"membership": {**item["membership"], "role": "observer"}}
                if item["membership"]["peerId"] == peer_id else item
                for item in base_members
            ] if state == "observer" else [
                item for item in base_members if item["membership"]["peerId"] != peer_id
            ])
            client = WorkroomClient(SimpleNamespace(_require_credentials=lambda: credentials))
            client.get = AsyncMock(return_value={
                "workroom": {"status": "executing"},
                "membership": {
                    "role": "observer" if party == "actor" and state == "observer" else "contributor",
                },
                "members": members,
                "latestMandates": [{"mandate": {"actorPeerId": actor_id, "revision": 1}}],
            })

            result = await client.guard_mandate_use({
                "workroomId": "11111111-1111-4111-8111-111111111111",
            })
            assert result["status"] == "denied", f"{party} {state}"
            assert result["code"] == "MANDATE_MISMATCH", f"{party} {state}"


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
    assert _routing_context(plan, agent_id, other_id, "observer") == {
        "directedToMe": False, "directMentions": [], "assignedSteps": [],
    }
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
        raw_events = [_raw_poll_record(event) for event in events]
        by_id = {event["event"]["eventId"]: event for event in events}
        client._read_raw_event_page = AsyncMock(return_value={"records": raw_events, "nextAfterSequence": None})
        client.get = AsyncMock(return_value={})
        client._decrypt_event = AsyncMock(side_effect=lambda record, _detail: by_id[record["event"]["eventId"]])
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
    raw_event = _raw_poll_record(event)
    client._read_raw_event_page = AsyncMock(return_value={"records": [raw_event], "nextAfterSequence": None})
    client.get = AsyncMock(return_value={})
    client._decrypt_event = AsyncMock(return_value=event)
    client._read_event_page = AsyncMock(return_value={"events": [event], "nextAfterSequence": None})
    handler = AsyncMock()

    failing_handler = AsyncMock(side_effect=RuntimeError("consumer failed"))
    with pytest.raises(RuntimeError, match="consumer failed"):
        await client.poll("11111111-1111-4111-8111-111111111111", failing_handler)
    assert state.workroom_cursors == {}
    assert state.workroom_event_failures == {}

    await client.poll("11111111-1111-4111-8111-111111111111", handler)

    autonomous_event = handler.await_args.args[0]
    assert [step["id"] for step in autonomous_event["content"]["steps"]] == ["mine"]
    assert [step["id"] for step in event["content"]["steps"]] == ["mine", "other", "done"]
    audit = await client.read_audit_events("11111111-1111-4111-8111-111111111111")
    assert [step["id"] for step in audit["events"][0]["content"]["steps"]] == ["mine", "other", "done"]


@pytest.mark.asyncio
async def test_poll_quarantines_poison_after_restart_and_continues_to_later_directed_event():
    workroom_id = "11111111-1111-4111-8111-111111111111"
    legacy_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
    poison_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
    later_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"
    renamed_poison_id = "abababab-abab-4bab-8bab-abababababab"
    poison_view = {
        "sequence": 2,
        "event": {"eventId": poison_id},
        "content": {"kind": "message", "body": "poison", "mentions": []},
        "directedToMe": True,
    }
    later_view = {
        "sequence": 3,
        "event": {"eventId": later_id},
        "content": {"kind": "message", "body": "run after poison", "mentions": []},
        "directedToMe": True,
    }
    legacy = {
        "sequence": 1,
        "event": {
            "eventId": legacy_id,
            "workroomId": workroom_id,
            "envelope": {"envelopeId": legacy_id},
        },
    }
    poison = _raw_poll_record(poison_view)
    later = _raw_poll_record(later_view)
    records = [legacy, poison, later]
    store = MemoryRuntimeStateStore()
    decrypted_ids: list[str] = []

    def make_client(state):
        async def mutate(mutator):
            mutator(state)
            await store.save(state)

        agent = SimpleNamespace(_runtime_state=state, _mutate_runtime_state=mutate)
        client = WorkroomClient(agent)

        def raw_page(_workroom_id, after_sequence, _limit, **_kwargs):
            remaining = [record for record in records if record["sequence"] > after_sequence]
            return {"records": remaining, "nextAfterSequence": None}

        def decrypt(record, _detail):
            event_id = record["event"]["eventId"]
            envelope_id = record["event"]["envelope"]["envelopeId"]
            decrypted_ids.append(event_id)
            if event_id == legacy_id:
                raise ValueError("LEGACY_NOT_OPENABLE")
            if envelope_id == poison_id:
                raise ValueError("WORKROOM_EVENT_KIND_MISMATCH")
            return later_view

        client._read_raw_event_page = AsyncMock(side_effect=raw_page)
        client.get = AsyncMock(return_value={})
        client._decrypt_event = AsyncMock(side_effect=decrypt)
        return client

    before_restart = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})
    first_client = make_client(before_restart)
    first_handler = AsyncMock()

    with pytest.raises(ValueError, match="WORKROOM_EVENT_KIND_MISMATCH"):
        await first_client.poll(workroom_id, first_handler)
    with pytest.raises(ValueError, match="WORKROOM_EVENT_KIND_MISMATCH"):
        await first_client.poll(workroom_id, first_handler)
    first_handler.assert_not_awaited()
    assert legacy_id not in decrypted_ids
    assert before_restart.workroom_cursors[workroom_id] == 1
    assert before_restart.workroom_event_failures[poison_id]["attempts"] == 2

    after_restart = await store.load()
    assert after_restart is not None
    renamed_poison = deepcopy(poison)
    renamed_poison["event"]["eventId"] = renamed_poison_id
    renamed_poison["event"]["idempotencyKey"] = "renamed-poison"
    records[1] = renamed_poison
    restarted = make_client(after_restart)
    restarted_handler = AsyncMock()
    quarantined = AsyncMock()

    assert await restarted.poll(
        workroom_id, restarted_handler, on_event_quarantined=quarantined,
    ) == 3
    restarted_handler.assert_awaited_once_with(later_view)
    quarantined.assert_awaited_once()
    assert quarantined.await_args.args[0] == after_restart.workroom_event_failures[poison_id]
    assert quarantined.await_args.args[0]["eventId"] == renamed_poison_id
    assert quarantined.await_args.args[0]["envelopeId"] == poison_id
    assert after_restart.workroom_event_failures[poison_id]["attempts"] == 3
    assert after_restart.workroom_event_failures[poison_id]["status"] == "quarantined"
    assert after_restart.workroom_cursors[workroom_id] == 3
    assert [item["eventId"] for item in restarted.list_quarantined_events(workroom_id)] == [legacy_id, renamed_poison_id]

    with pytest.raises(ValueError, match="LEGACY_NOT_OPENABLE"):
        await restarted.read_audit_events(workroom_id)
    assert after_restart.workroom_cursors[workroom_id] == 3


@pytest.mark.asyncio
async def test_poll_rejects_cross_workroom_regressive_and_mismatched_raw_pages_without_state_change():
    workroom_id = "11111111-1111-4111-8111-111111111111"
    view = {
        "sequence": 2,
        "event": {"eventId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"},
        "content": {"kind": "message", "body": "valid", "mentions": []},
        "directedToMe": False,
    }
    valid = _raw_poll_record(view)
    other_workroom_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    cross_workroom = deepcopy(valid)
    cross_workroom["event"]["workroomId"] = other_workroom_id
    cross_workroom["event"]["envelope"]["workroomId"] = other_workroom_id
    mismatched_timestamp = deepcopy(valid)
    mismatched_timestamp["event"]["createdAt"] = "2026-09-04T12:00:01.000Z"
    regressive_first = deepcopy(valid)
    regressive_first["sequence"] = 2
    regressive_second = deepcopy(valid)
    regressive_second["sequence"] = 1
    invalid_pages = [
        ({"events": [cross_workroom], "nextAfterSequence": None}, "WORKROOM_EVENT_PAGE_WORKROOM_MISMATCH"),
        ({"events": [valid, deepcopy(valid)], "nextAfterSequence": None}, "WORKROOM_EVENT_SEQUENCE_INVALID"),
        ({"events": [regressive_first, regressive_second], "nextAfterSequence": None}, "WORKROOM_EVENT_SEQUENCE_INVALID"),
        ({"events": [mismatched_timestamp], "nextAfterSequence": None}, "WORKROOM_EVENT_METADATA_MISMATCH"),
        ({"events": [valid], "nextAfterSequence": 99}, "WORKROOM_EVENT_CURSOR_INVALID"),
    ]

    for page, error_code in invalid_pages:
        state = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})

        async def mutate(mutator):
            mutator(state)

        agent = SimpleNamespace(
            _runtime_state=state,
            _mutate_runtime_state=mutate,
            _request=AsyncMock(return_value=page),
        )
        client = WorkroomClient(agent)
        handler = AsyncMock()
        with pytest.raises(ValueError, match=error_code):
            await client.poll(workroom_id, handler)
        handler.assert_not_awaited()
        assert state.workroom_cursors == {}
        assert state.workroom_event_failures == {}


@pytest.mark.asyncio
async def test_poll_deduplicates_a_relay_renamed_event_by_signed_envelope_id():
    workroom_id = "11111111-1111-4111-8111-111111111111"
    envelope_id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
    renamed_event_id = "ffffffff-ffff-4fff-8fff-ffffffffffff"
    view = {
        "sequence": 1,
        "event": {"eventId": envelope_id},
        "content": {"kind": "message", "body": "execute once", "mentions": []},
        "directedToMe": True,
    }
    original = _raw_poll_record(view)
    renamed = deepcopy(original)
    renamed["sequence"] = 2
    renamed["event"]["eventId"] = renamed_event_id
    renamed["event"]["idempotencyKey"] = "renamed-by-relay"
    state = RuntimeState(outbox=[], inbox=[], processed_incoming={}, counterparties={})

    async def mutate(mutator):
        mutator(state)

    agent = SimpleNamespace(
        _runtime_state=state,
        _mutate_runtime_state=mutate,
        _request=AsyncMock(return_value={
            "events": [original, renamed], "nextAfterSequence": None,
        }),
    )
    client = WorkroomClient(agent)
    client.get = AsyncMock(return_value={})
    client._decrypt_event = AsyncMock(side_effect=lambda record, _detail: {
        **view,
        "sequence": record["sequence"],
        "event": record["event"],
    })
    handler = AsyncMock()

    assert await client.poll(workroom_id, handler) == 2
    assert handler.await_count == 1
    assert state.workroom_cursors[workroom_id] == 2
    assert state.processed_workroom_events[envelope_id] is True
    assert renamed_event_id not in state.processed_workroom_events


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

    observer = deepcopy(detail)
    observer["members"][1]["membership"]["role"] = "observer"
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_TARGET_NOT_EXECUTABLE"):
        _validate_routing_bindings({"kind": "message", "mentions": [mention]}, observer, actor_id)
    _validate_routing_bindings(
        {"kind": "message", "mentions": [mention]}, observer, actor_id,
        allow_observer_targets=True,
    )
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
                    "encryptionPublicKey": "YWN0b3ItZW5j", "signingPublicKey": "actor-sign",
                },
            },
            {
                "membership": {"peerId": target_id, "peerType": "AGENT", "role": "worker"},
                "peer": {
                    "id": target_id, "handle": "@worker.agent", "type": "AGENT", "status": "ACTIVE",
                    "encryptionPublicKey": "dGFyZ2V0LWVuYw", "signingPublicKey": "target-sign",
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
    snapshot = [{
        "peerId": actor_id, "peerType": "AGENT", "role": "contributor",
        "handle": "@author.agent", "signingPublicKey": "actor-sign",
        "encryptionPublicKey": "YWN0b3ItZW5j",
    }, {
        "peerId": target_id, "peerType": "AGENT", "role": "contributor",
        "handle": "@worker.agent", "signingPublicKey": "target-sign",
        "encryptionPublicKey": "dGFyZ2V0LWVuYw",
    }]
    record = {
        "event": {
            "eventId": "55555555-5555-4555-8555-555555555555",
            "threadId": thread_id, "actorPeerId": actor_id, "kind": "message",
            "envelope": {
                "cipherSuite": "ATALK_GROUP_BOX_V1",
                "wrappedKeys": [{
                    "recipientPeerId": item["peerId"],
                    "recipientEncryptionKeyHash": hash_b64url_payload(item["encryptionPublicKey"]),
                } for item in snapshot],
            },
        },
        "membershipSnapshot": snapshot,
    }
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        await recipient._decrypt_event(record, detail)

    valid = deepcopy(forged)
    valid["mentions"][0]["handle"] = "@worker.agent"
    publishing_detail = deepcopy(detail)
    publishing_detail["members"][1]["membership"]["role"] = "observer"
    client.get.return_value = publishing_detail
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_TARGET_NOT_EXECUTABLE"):
        await client.publish("11111111-1111-4111-8111-111111111111", thread_id, valid)
    observer_detail = deepcopy(publishing_detail)
    observer_detail["membership"]["role"] = "observer"
    monkeypatch.setattr("atalk.workrooms.decrypt_workroom_payload", lambda **_kwargs: valid)
    decrypted = await recipient._decrypt_event(record, detail)
    assert decrypted["directedToMe"] is True
    assert decrypted["routing"] == {
        "directedToMe": True,
        "directMentions": [valid["mentions"][0]],
        "assignedSteps": [],
    }
    observer_decrypted = await recipient._decrypt_event(record, observer_detail)
    assert observer_decrypted["directedToMe"] is False
    assert observer_decrypted["routing"] == {
        "directedToMe": False, "directMentions": [], "assignedSteps": [],
    }
    legacy_record = deepcopy(record)
    legacy_record.pop("membershipSnapshot")
    legacy_decrypted = await recipient._decrypt_event(legacy_record, detail)
    assert legacy_decrypted["directedToMe"] is False
    assert legacy_decrypted["routing"] == {
        "directedToMe": False, "directMentions": [], "assignedSteps": [],
    }
    n_minus_one_record = deepcopy(record)
    for wrapped in n_minus_one_record["event"]["envelope"]["wrappedKeys"]:
        wrapped.pop("recipientEncryptionKeyHash")
    n_minus_one_decrypted = await recipient._decrypt_event(n_minus_one_record, detail)
    assert n_minus_one_decrypted["directedToMe"] is False


@pytest.mark.asyncio
async def test_historical_membership_snapshot_survives_removal_and_role_changes(monkeypatch):
    actor_id = "22222222-2222-4222-8222-222222222222"
    removed_id = "33333333-3333-4333-8333-333333333333"
    remaining_id = "44444444-4444-4444-8444-444444444444"
    thread_id = "55555555-5555-4555-8555-555555555555"
    payload = {
        "version": 1, "kind": "message", "threadId": thread_id, "body": "Historical request",
        "mentions": [{
            "peerId": removed_id, "handle": "@removed.agent",
            "peerType": "AGENT", "intent": "direct",
        }],
    }
    snapshot = [{
        "peerId": actor_id, "peerType": "HUMAN", "role": "owner", "handle": "@former.owner",
        "signingPublicKey": "historical-sign", "encryptionPublicKey": "aGlzdG9yaWNhbC1lbmM",
    }, {
        "peerId": removed_id, "peerType": "AGENT", "role": "contributor", "handle": "@removed.agent",
        "signingPublicKey": "removed-sign", "encryptionPublicKey": "cmVtb3ZlZC1lbmM",
    }, {
        "peerId": remaining_id, "peerType": "AGENT", "role": "contributor", "handle": "@remaining.agent",
        "signingPublicKey": "remaining-sign", "encryptionPublicKey": "cmVtYWluaW5nLWVuYw",
    }]
    record = {
        "sequence": 8,
        "event": {
            "eventId": "66666666-6666-4666-8666-666666666666",
            "threadId": thread_id,
            "actorPeerId": actor_id,
            "kind": "message",
            "envelope": {
                "cipherSuite": "ATALK_GROUP_BOX_V1",
                "wrappedKeys": [{
                    "recipientPeerId": item["peerId"],
                    "recipientEncryptionKeyHash": hash_b64url_payload(item["encryptionPublicKey"]),
                } for item in snapshot],
            },
        },
        "membershipSnapshot": snapshot,
    }
    remaining_credentials = SimpleNamespace(
        peer={"id": remaining_id}, keys=SimpleNamespace(encryption_secret_key="remaining-secret"),
    )
    remaining_detail = {
        "membership": {"peerId": remaining_id, "role": "contributor"},
        "members": [{
            "membership": {"peerId": remaining_id, "peerType": "AGENT", "role": "contributor"},
            "peer": {
                "id": remaining_id, "handle": "@remaining.agent", "type": "AGENT", "status": "ACTIVE",
                "signingPublicKey": "remaining-sign", "encryptionPublicKey": "cmVtYWluaW5nLWVuYw",
            },
        }],
    }
    client = WorkroomClient(SimpleNamespace(
        _require_credentials=lambda: remaining_credentials, _request=AsyncMock(),
    ))
    monkeypatch.setattr("atalk.workrooms.decrypt_workroom_payload", lambda **_kwargs: payload)

    decrypted = await client._decrypt_event(record, remaining_detail)
    assert decrypted["directedToMe"] is False
    assert decrypted["actor"]["handle"] == "@former.owner"
    assert decrypted["actor"]["signingPublicKey"] == "historical-sign"

    promoted_credentials = SimpleNamespace(
        peer={"id": removed_id}, keys=SimpleNamespace(encryption_secret_key="removed-secret"),
    )
    promoted_detail = {
        "membership": {"peerId": removed_id, "role": "contributor"},
        "members": [{
            "membership": {"peerId": removed_id, "peerType": "AGENT", "role": "contributor"},
            "peer": {
                "id": removed_id, "handle": "@removed.agent", "type": "AGENT", "status": "ACTIVE",
                "signingPublicKey": "removed-sign", "encryptionPublicKey": "cmVtb3ZlZC1lbmM",
            },
        }],
    }
    observer_record = deepcopy(record)
    observer_record["membershipSnapshot"][1]["role"] = "observer"
    promoted = WorkroomClient(SimpleNamespace(
        _require_credentials=lambda: promoted_credentials, _request=AsyncMock(),
    ))
    observer_view = await promoted._decrypt_event(observer_record, promoted_detail)
    assert observer_view["directedToMe"] is False

    forged_snapshot = deepcopy(record)
    forged_snapshot["membershipSnapshot"][1]["handle"] = "@wrong.agent"
    with pytest.raises(ValueError, match="WORKROOM_ROUTING_IDENTITY_MISMATCH"):
        await client._decrypt_event(forged_snapshot, remaining_detail)

    stale_key_snapshot = deepcopy(record)
    stale_key_snapshot["membershipSnapshot"][1]["encryptionPublicKey"] = "cm90YXRlZC1lbmM"
    with pytest.raises(ValueError, match="WORKROOM_EVENT_RECIPIENT_KEY_MISMATCH"):
        await client._decrypt_event(stale_key_snapshot, remaining_detail)


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
