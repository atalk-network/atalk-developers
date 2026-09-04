from __future__ import annotations

import asyncio
import json
import os

import httpx
import pytest

import atalk.agent as agent_module
from atalk import (
    ATALK_SDK_VERSION,
    Agent,
    Credentials,
    MemoryRuntimeStateStore,
    RuntimeManager,
    RuntimeManagerError,
    RuntimeComponent,
    RuntimeOptions,
    parse_runtime_update_advisory,
    persist_runtime_update_status,
    resolve_runtime_check_in,
)
from atalk.protocol import IdentityKeys


class MemoryCredentials:
    def __init__(self) -> None:
        self.value = None

    async def load(self):
        return self.value

    async def save(self, credentials):
        self.value = credentials


def advisory(**overrides):
    return {
        "status": "UPDATE_AVAILABLE",
        "currentVersion": ATALK_SDK_VERSION,
        "recommendedVersion": "0.1.0a12",
        "minimumVersion": "0.1.0a10",
        "severity": "INFO",
        "releaseNotesUrl": "https://github.com/atalk-network/atalk-developers/releases/tag/python-v0.1.0a12",
        "policy": "NOTIFY",
        "checkedAt": "2026-09-04T12:00:00.000Z",
        **overrides,
    }


def test_builds_exact_wire_shape_and_validates_advisory():
    assert RuntimeManager is not None
    assert issubclass(RuntimeManagerError, RuntimeError)
    metadata = resolve_runtime_check_in(RuntimeOptions(
        integration=RuntimeComponent("atalk-hermes", ATALK_SDK_VERSION),
        capabilities=["text", "text", "runtime.auto-update"],
    ))
    assert metadata.to_wire() == {
        "sdk": {"name": "atalk-sdk", "version": "0.1.0a11"},
        "integration": {"name": "atalk-hermes", "version": "0.1.0a11"},
        "protocolVersion": 1,
        "channel": "PREVIEW",
        "capabilities": ["runtime.auto-update", "text"],
    }
    parsed = parse_runtime_update_advisory(advisory())
    assert parsed is not None
    assert parsed.recommended_version == "0.1.0a12"
    invalid = advisory()
    invalid.pop("currentVersion")
    assert parse_runtime_update_advisory(invalid) is None
    assert parse_runtime_update_advisory(advisory(checkedAt="not-a-date")) is None
    assert parse_runtime_update_advisory(advisory(releaseNotesUrl="file:///tmp/release")) is None


def test_custom_sdk_claims_auto_update_only_when_started_by_manager(monkeypatch, tmp_path):
    monkeypatch.delenv("ATALK_RUNTIME_MANAGER", raising=False)
    unmanaged = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
    )
    assert "runtime.auto-update" not in unmanaged.runtime_metadata.capabilities

    monkeypatch.setenv("ATALK_RUNTIME_MANAGER", "1")
    monkeypatch.setenv("ATALK_UPDATE_STATUS_PATH", str(tmp_path / "managed-update.json"))
    managed = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
    )
    assert "runtime.auto-update" in managed.runtime_metadata.capabilities
    assert managed._runtime_update_status_path == (tmp_path / "managed-update.json").resolve()

    disabled = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
        runtime=RuntimeOptions(update_status_path=False),
    )
    assert "runtime.auto-update" not in disabled.runtime_metadata.capabilities


def test_persists_private_atomic_supervisor_handoff(tmp_path):
    path = tmp_path / "nested" / "update.json"
    metadata = resolve_runtime_check_in()
    parsed = parse_runtime_update_advisory(advisory())
    assert parsed is not None
    persist_runtime_update_status(path, metadata, parsed)
    value = json.loads(path.read_text())
    assert value == {"version": 1, "metadata": metadata.to_wire(), "advisory": parsed.to_wire()}
    assert path.stat().st_mode & 0o777 == 0o600
    assert not list(path.parent.glob("*.tmp"))


@pytest.mark.asyncio
async def test_check_in_is_advisory_private_and_emits_only_material_changes(tmp_path):
    runtime = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
        runtime=RuntimeOptions(update_status_path=tmp_path / "update.json"),
    )
    runtime._credentials = Credentials(
        session_token="session",
        peer={"id": "agent"},
        keys=IdentityKeys.generate(),
    )
    requests = []
    responses = [advisory(), advisory(checkedAt="2026-09-04T18:00:00.000Z")]

    async def request(method, path, **kwargs):
        requests.append((method, path, kwargs))
        return httpx.Response(200, json={"advisory": responses.pop(0)})

    runtime._authorized_http_request = request
    updates = []
    callback_finished = asyncio.Event()

    @runtime.on_update
    async def updated(value):
        updates.append(value)
        callback_finished.set()

    await runtime._check_in_runtime_safely()
    await asyncio.wait_for(callback_finished.wait(), timeout=0.1)
    await runtime._check_in_runtime_safely()
    assert len(updates) == 1
    assert requests[0][2]["json"] == runtime.runtime_metadata.to_wire()
    assert runtime.runtime_update is not None
    assert json.loads((tmp_path / "update.json").read_text())["advisory"]["checkedAt"] == (
        "2026-09-04T18:00:00.000Z"
    )


@pytest.mark.asyncio
async def test_old_or_hung_check_in_never_blocks_or_fails_runtime(monkeypatch):
    runtime = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
        runtime=RuntimeOptions(update_status_path=False),
    )
    runtime._credentials = Credentials("session", {"id": "agent"}, IdentityKeys.generate())
    errors = []
    runtime.on_error(errors.append)

    async def missing(*_args, **_kwargs):
        return httpx.Response(404)

    runtime._authorized_http_request = missing
    await runtime._check_in_runtime_safely()
    assert errors == []

    never = asyncio.Event()

    async def hanging(*_args, **_kwargs):
        await never.wait()
        raise AssertionError("unreachable")

    runtime._authorized_http_request = hanging
    monkeypatch.setattr(agent_module, "_RUNTIME_CHECK_IN_TIMEOUT_SECONDS", 0.01)
    await asyncio.wait_for(runtime._check_in_runtime_safely(), timeout=0.2)
    assert len(errors) == 1
    assert isinstance(errors[0], TimeoutError)


@pytest.mark.asyncio
async def test_hung_or_broken_update_hooks_do_not_block_future_check_ins():
    runtime = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
        runtime=RuntimeOptions(update_status_path=False),
    )
    runtime._credentials = Credentials("session", {"id": "agent"}, IdentityKeys.generate())
    request_count = 0
    release_hook = asyncio.Event()

    async def request(*_args, **_kwargs):
        nonlocal request_count
        request_count += 1
        return httpx.Response(200, json={"advisory": advisory(
            checkedAt=f"2026-09-04T{request_count:02}:00:00.000Z",
            **({"recommendedVersion": "0.1.0a13"} if request_count >= 3 else {}),
        )})

    async def hanging(_value):
        await release_hook.wait()

    runtime._authorized_http_request = request
    runtime.on_update(hanging)
    await asyncio.wait_for(runtime._check_in_runtime_safely(), timeout=0.1)
    await asyncio.wait_for(runtime._check_in_runtime_safely(), timeout=0.1)
    assert request_count == 2
    assert len(runtime._runtime_update_tasks) == 1
    await runtime._stop_runtime_check_ins()
    assert not runtime._runtime_update_tasks

    errors = []
    error_finished = asyncio.Event()

    async def raising(_value):
        raise RuntimeError("broken update hook")

    async def broken_error_handler(error):
        errors.append(error)
        error_finished.set()
        raise RuntimeError("broken error hook")

    runtime.on_update(raising)
    runtime.on_error(broken_error_handler)
    await runtime._check_in_runtime_safely()
    await asyncio.wait_for(error_finished.wait(), timeout=0.1)
    assert isinstance(errors[0], RuntimeError)
    await runtime._stop_runtime_check_ins()


@pytest.mark.asyncio
async def test_initial_check_in_is_started_in_background_without_delaying_startup():
    runtime = Agent(
        credential_store=MemoryCredentials(),
        runtime_state_store=MemoryRuntimeStateStore(),
        supervision=False,
        runtime=RuntimeOptions(update_status_path=False),
    )
    started = asyncio.Event()
    release = asyncio.Event()

    async def delayed_check_in():
        started.set()
        await release.wait()

    runtime._check_in_runtime_safely = delayed_check_in
    runtime._start_runtime_check_ins()
    await asyncio.wait_for(started.wait(), timeout=0.1)
    assert runtime._runtime_check_in_task is not None
    await runtime._stop_runtime_check_ins()
    assert runtime._runtime_check_in_task is None


def test_runtime_status_is_not_written_with_world_permissions(tmp_path):
    path = tmp_path / "update.json"
    path.write_text("legacy")
    os.chmod(path, 0o666)
    parsed = parse_runtime_update_advisory(advisory())
    assert parsed is not None
    persist_runtime_update_status(path, resolve_runtime_check_in(), parsed)
    assert path.stat().st_mode & 0o777 == 0o600
