from __future__ import annotations

import base64
import json
import hashlib
import os
from pathlib import Path

import pytest

from atalk import (
    RuntimeComponent,
    RuntimeOptions,
    parse_runtime_update_advisory,
    persist_runtime_update_status,
    resolve_runtime_check_in,
)
from atalk.runtime_manager import (
    ManagedRelease,
    RuntimeManager,
    RuntimeManagerError,
    _exclusive_lock,
    _health_response_is_ready,
    _trusted_publisher_provenance_matches,
)


class FakeProcess:
    next_pid = 8000

    def __init__(self):
        self.pid = FakeProcess.next_pid
        FakeProcess.next_pid += 1
        self.alive = True
        self.returncode = None

    def poll(self):
        return None if self.alive else self.returncode


def make_manager(tmp_path, **overrides):
    values = {
        "stack": "hermes",
        "profile": "agent-one",
        "initial_version": "0.1.0a11",
        "credential_path": tmp_path / "credentials.json",
        "command": ["hermes", "gateway", "start"],
        "root": tmp_path / "manager",
        "health_grace_seconds": 0,
        "health_timeout_seconds": 0.1,
        "poll_interval_seconds": 0.01,
        "shutdown_timeout_seconds": 0.01,
    }
    values.update(overrides)
    return RuntimeManager(**values)


def update_status(
    policy="COMPATIBLE", severity="INFO", status="UPDATE_AVAILABLE", recommended="0.1.0a12",
):
    parsed = parse_runtime_update_advisory({
        "status": status,
        "currentVersion": "0.1.0a11",
        "recommendedVersion": recommended,
        "minimumVersion": "0.1.0a10",
        "severity": severity,
        "policy": policy,
        "checkedAt": "2026-09-04T12:00:00.000Z",
    })
    assert parsed is not None
    return parsed


def write_status(manager, *, capabilities=None, policy="COMPATIBLE", severity="INFO"):
    metadata = resolve_runtime_check_in(RuntimeOptions(
        integration=RuntimeComponent("atalk-hermes", "0.1.0a11"),
        capabilities=capabilities or ["runtime.auto-update", "text"],
    ))
    persist_runtime_update_status(
        manager.paths.update_status,
        metadata,
        update_status(policy=policy, severity=severity),
    )


def test_manager_accepts_only_fixed_stacks_and_exact_noninjectable_versions(tmp_path):
    manager = make_manager(tmp_path)
    assert manager.stack == "hermes"
    with pytest.raises(ValueError, match="PEP 440"):
        make_manager(tmp_path, initial_version="0.1.0a12;touch /tmp/nope")
    with pytest.raises(ValueError, match="Credentials"):
        make_manager(
            tmp_path,
            credential_path=tmp_path / "manager" / "agent-one" / "releases" / "secret.json",
        )


def test_profile_lock_prevents_two_supervisors(tmp_path):
    lock = tmp_path / "private" / "manager.lock"
    with _exclusive_lock(lock):
        with pytest.raises(RuntimeManagerError, match="already owns"):
            with _exclusive_lock(lock):
                pass


def test_stage_downloads_exact_allowlisted_pins_and_verifies_pypi_hashes(tmp_path, monkeypatch):
    wheel_bytes = b"verified wheel fixture"
    digest = hashlib.sha256(wheel_bytes).hexdigest()
    wheel_names = {
        "atalk-sdk": "atalk_sdk-0.1.0a11-py3-none-any.whl",
        "atalk-hermes": "atalk_hermes-0.1.0a11-py3-none-any.whl",
    }
    commands = []

    def fake_venv_create(_builder, path):
        (Path(path) / "bin").mkdir(parents=True)
        (Path(path) / "bin" / "python").write_text("fixture")

    def runner(command, **_kwargs):
        commands.append(command)
        if "download" in command:
            destination = Path(command[command.index("--dest") + 1])
            for filename in wheel_names.values():
                (destination / filename).write_bytes(wheel_bytes)
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def hashes(package, _version):
        normalized = package.replace("_", "-")
        filename = wheel_names[normalized]
        return {filename: digest}

    manager = make_manager(tmp_path, command_runner=runner, artifact_hash_fetcher=hashes)
    manager._prepare_private_directories()
    manager.verify = lambda _release: None
    monkeypatch.setattr("atalk.runtime_manager.venv.EnvBuilder.create", fake_venv_create)
    release = manager.stage("0.1.0a11")

    assert release.version == "0.1.0a11"
    assert commands[0][-2:] == ["atalk-sdk==0.1.0a11", "atalk-hermes==0.1.0a11"]
    assert "download" in commands[0]
    assert "--index-url" in commands[0]
    assert commands[0][commands[0].index("--index-url") + 1] == "https://pypi.org/simple"
    assert "install" in commands[1]
    assert "--no-index" in commands[1]
    marker = json.loads((release.path / "release.json").read_text())
    assert marker["packages"] == ["atalk-sdk==0.1.0a11", "atalk-hermes==0.1.0a11"]
    assert marker["artifacts"] == {name: digest for name in sorted(wheel_names.values())}


def test_tampered_download_hash_is_rejected(tmp_path):
    manager = make_manager(
        tmp_path,
        artifact_hash_fetcher=lambda _package, _version: {
            "atalk_sdk-0.1.0a11-py3-none-any.whl": "0" * 64,
        },
    )
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    (wheelhouse / "atalk_sdk-0.1.0a11-py3-none-any.whl").write_bytes(b"tampered")
    with pytest.raises(RuntimeManagerError, match="SHA-256"):
        manager._verify_downloaded_wheels(wheelhouse)


def test_official_wheels_require_exact_trusted_publisher_provenance():
    filename = "atalk_sdk-0.1.0a11-py3-none-any.whl"
    digest = "a" * 64
    statement = base64.b64encode(json.dumps({
        "_type": "https://in-toto.io/Statement/v1",
        "subject": [{"name": filename, "digest": {"sha256": digest}}],
        "predicateType": "https://docs.pypi.org/attestations/publish/v1",
        "predicate": None,
    }).encode()).decode()
    provenance = {
        "version": 1,
        "attestation_bundles": [{
            "publisher": {
                "environment": "pypi",
                "kind": "GitHub",
                "repository": "atalk-network/atalk-developers",
                "workflow": "release-python.yml",
            },
            "attestations": [{"version": 1, "envelope": {"statement": statement}}],
        }],
    }

    assert _trusted_publisher_provenance_matches(provenance, filename, digest) is True
    provenance["attestation_bundles"][0]["publisher"]["repository"] = "attacker/fork"
    assert _trusted_publisher_provenance_matches(provenance, filename, digest) is False
    provenance["attestation_bundles"][0]["publisher"]["repository"] = "atalk-network/atalk-developers"
    assert _trusted_publisher_provenance_matches(provenance, filename, "b" * 64) is False


def test_private_status_is_authenticated_and_local_ceiling_restricts_owner_policy(tmp_path):
    manager = make_manager(tmp_path)
    write_status(manager)
    status = manager.read_update_status()
    assert status is not None
    assert manager.should_auto_update(status, "0.1.0a11") is True

    notify_ceiling = make_manager(tmp_path, profile="notify", update_ceiling="NOTIFY")
    write_status(notify_ceiling)
    notify = notify_ceiling.read_update_status()
    assert notify is not None
    assert notify_ceiling.should_auto_update(notify, "0.1.0a11") is False

    security_ceiling = make_manager(tmp_path, profile="security", update_ceiling="SECURITY")
    write_status(security_ceiling, severity="INFO")
    info = security_ceiling.read_update_status()
    assert info is not None
    assert security_ceiling.should_auto_update(info, "0.1.0a11") is False
    write_status(security_ceiling, severity="SECURITY")
    security = security_ceiling.read_update_status()
    assert security is not None
    assert security_ceiling.should_auto_update(security, "0.1.0a11") is True

    write_status(manager, policy="NOTIFY", severity="SECURITY")
    owner_notify = manager.read_update_status()
    assert owner_notify is not None
    assert manager.should_auto_update(owner_notify, "0.1.0a11") is False

    outside_line = type(status)(
        metadata=status.metadata,
        advisory=update_status(recommended="1.0.0"),
    )
    assert manager.should_auto_update(outside_line, "0.1.0a11") is False


def test_status_without_manager_capability_or_with_unsafe_permissions_is_ignored(tmp_path):
    manager = make_manager(tmp_path)
    write_status(manager, capabilities=["text"])
    status = manager.read_update_status()
    assert status is not None
    assert manager.should_auto_update(status, "0.1.0a11") is False

    os.chmod(manager.paths.update_status, 0o644)
    assert manager.read_update_status() is None
    os.chmod(manager.paths.update_status, 0o600)
    original = manager.paths.update_status
    link = original.with_name("linked.json")
    link.symlink_to(original)
    linked = make_manager(tmp_path, profile="linked", update_status_path=link)
    assert linked.read_update_status() is None

    value = json.loads(original.read_text())
    value["metadata"]["integration"]["name"] = "untrusted-package"
    original.write_text(json.dumps(value))
    os.chmod(original, 0o600)
    assert manager.read_update_status() is None


def test_failed_candidate_restarts_previous_runtime_after_atomic_rollback(tmp_path):
    now = [1_800_000_000.0]
    manager = make_manager(tmp_path, clock=lambda: now[0])
    manager._prepare_private_directories()
    old = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    original_process = FakeProcess()
    launched = []
    operations = []

    def stage(version):
        operations.append(f"stage:{version}")
        return candidate

    def stop(process):
        operations.append(f"stop:{process.pid}")
        process.alive = False
        process.returncode = 0

    def launch(release):
        process = FakeProcess()
        launched.append((release, process))
        operations.append(f"launch:{release.version}")
        return process

    def health(process):
        return launched[-1][0].version == old.version

    manager.stage = stage
    manager.stop_process = stop
    manager.launch = launch
    manager.health_check = health
    result = manager.reconcile(original_process, old, "0.1.0a12")

    assert operations[:2] == ["stage:0.1.0a12", f"stop:{original_process.pid}"]
    assert [release.version for release, _ in launched] == ["0.1.0a12", "0.1.0a11"]
    assert result.rolled_back is True
    assert result.release == old
    assert result.process is launched[-1][1]
    assert result.process.poll() is None
    pointer = json.loads(manager.paths.pointer.read_text())
    state = json.loads(manager.paths.state.read_text())
    assert pointer["release"] == "0.1.0a11"
    assert state["status"] == "ROLLED_BACK"
    assert state["update"] == {
        "targetVersion": "0.1.0a12",
        "category": "CANDIDATE",
        "reason": "candidate_health_or_switch_failed",
        "failures": 1,
        "failedAt": "2027-01-15T08:00:00.000Z",
        "nextRetryAt": "2027-01-15T14:00:00.000Z",
        "quarantined": True,
    }
    assert manager.update_deferment("0.1.0a12") is not None
    assert manager.update_deferment("0.1.0a13") is None
    # The monitor consults this durable gate before reconcile, so the process
    # returned by rollback remains untouched throughout the quarantine.
    stops_before = len([item for item in operations if item.startswith("stop:")])
    if not manager.update_deferment("0.1.0a12"):
        manager.reconcile(result.process, old, "0.1.0a12")
    assert len([item for item in operations if item.startswith("stop:")]) == stops_before
    assert result.process.poll() is None

    restarted_manager = make_manager(tmp_path, clock=lambda: now[0])
    assert restarted_manager.update_deferment("0.1.0a12") is not None
    now[0] += 6 * 60 * 60 + 1
    assert restarted_manager.update_deferment("0.1.0a12") is None


def test_run_skips_quarantined_candidate_without_interrupting_previous_runtime(tmp_path, monkeypatch):
    now = [1_800_000_000.0]
    manager = make_manager(tmp_path, clock=lambda: now[0])
    manager.paths.credential.write_text("{}")
    os.chmod(manager.paths.credential, 0o600)
    write_status(manager)
    manager._record_update_failure(
        "0.1.0a12", "CANDIDATE", "candidate_health_or_switch_failed",
    )
    current = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    process = FakeProcess()
    manager._load_current_release = lambda: current
    manager.launch = lambda _release: process
    manager.health_check = lambda _process: True
    reconciles = []
    manager.reconcile = lambda *_args: reconciles.append(_args)
    stops = []

    def stop(child):
        stops.append(child.pid)
        child.alive = False
        child.returncode = 0

    states = []
    write_state = manager._write_state

    def record_state(status, *args, **kwargs):
        states.append(status)
        write_state(status, *args, **kwargs)

    manager.stop_process = stop
    manager._write_state = record_state
    monkeypatch.setattr(
        "atalk.runtime_manager.time.sleep",
        lambda _seconds: setattr(manager, "_stopping", True),
    )

    assert manager.run() == 0
    assert reconciles == []
    # The sole stop is the intentional manager shutdown after the test loop.
    assert stops == [process.pid]
    assert states == ["RUNNING", "UPDATE_DEFERRED", "STOPPED"]


def test_staging_failure_keeps_previous_process_running(tmp_path):
    now = [1_800_000_000.0]
    manager = make_manager(tmp_path, clock=lambda: now[0])
    old = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    process = FakeProcess()

    def fail(_version):
        raise RuntimeManagerError("registry unavailable")

    manager.stage = fail
    with pytest.raises(RuntimeManagerError, match="registry unavailable"):
        manager.reconcile(process, old, "0.1.0a12")
    assert process.poll() is None
    first = manager.update_deferment("0.1.0a12")
    assert first is not None
    assert first.category == "STAGING"
    assert first.quarantined is False
    assert first.next_retry_at == "2027-01-15T08:05:00.000Z"

    # Cooldown survives process restarts and grows after the next failed retry.
    restarted = make_manager(tmp_path, clock=lambda: now[0])
    assert restarted.update_deferment("0.1.0a12") is not None
    now[0] += 5 * 60 + 1
    assert restarted.update_deferment("0.1.0a12") is None
    restarted.stage = fail
    with pytest.raises(RuntimeManagerError):
        restarted.reconcile(process, old, "0.1.0a12")
    second = restarted.update_deferment("0.1.0a12")
    assert second is not None
    assert second.failures == 2
    assert second.next_retry_at == "2027-01-15T08:20:01.000Z"


def test_failure_backoff_has_persistent_upper_bounds_without_sleeping(tmp_path):
    manager = make_manager(tmp_path, clock=lambda: 1_800_000_000.0)
    for _ in range(10):
        staging = manager._record_update_failure(
            "0.1.0a12", "STAGING", "registry_or_staging_failed",
        )
        candidate = manager._record_update_failure(
            "0.1.0a13", "CANDIDATE", "candidate_health_or_switch_failed",
        )

    assert staging.failures == 10
    assert staging.next_retry_at == "2027-01-15T14:00:00.000Z"
    assert candidate.failures == 10
    assert candidate.next_retry_at == "2027-01-22T08:00:00.000Z"
    restarted = make_manager(tmp_path, clock=lambda: 1_800_000_000.0)
    assert restarted.update_deferment("0.1.0a12") == staging
    assert restarted.update_deferment("0.1.0a13") == candidate


def test_successful_candidate_clears_its_persistent_cooldown(tmp_path):
    now = [1_800_000_000.0]
    manager = make_manager(tmp_path, clock=lambda: now[0])
    manager._prepare_private_directories()
    old = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    manager._record_update_failure("0.1.0a12", "STAGING", "registry_or_staging_failed")
    now[0] += 5 * 60 + 1
    manager.stage = lambda _version: candidate
    manager.stop_process = lambda process: setattr(process, "alive", False)
    launched = FakeProcess()
    manager.launch = lambda _release: launched
    manager.health_check = lambda _process: True
    result = manager.reconcile(FakeProcess(), old, "0.1.0a12")
    assert result.updated is True
    assert result.process is launched
    assert manager.update_deferment("0.1.0a12", include_expired=True) is None


def test_manager_state_and_pointer_never_persist_command_or_credentials(tmp_path):
    manager = make_manager(tmp_path, command=["python", "agent.py", "--secret", "do-not-save"])
    manager._prepare_private_directories()
    release = ManagedRelease("0.1.0a11", tmp_path / "release", tmp_path / "release" / "site")
    manager._write_pointer(release)
    manager._write_state("RUNNING", release, 123)
    combined = manager.paths.pointer.read_text() + manager.paths.state.read_text()
    assert "do-not-save" not in combined
    assert str(manager.paths.credential) not in combined
    assert manager.paths.pointer.stat().st_mode & 0o777 == 0o600
    assert manager.paths.state.stat().st_mode & 0o777 == 0o600


def test_launch_requires_prior_pairing_and_never_inherits_activation_token(tmp_path, monkeypatch):
    captured = {}

    def factory(command, **kwargs):
        captured["command"] = command
        captured["environment"] = kwargs["env"]
        return FakeProcess()

    manager = make_manager(tmp_path, process_factory=factory)
    release = ManagedRelease("0.1.0a11", tmp_path / "release", tmp_path / "release" / "site")
    with pytest.raises(RuntimeManagerError, match="Pair this agent once"):
        manager.launch(release)
    manager.paths.credential.write_text("{}")
    os.chmod(manager.paths.credential, 0o600)
    monkeypatch.setenv("ATALK_AGENT_TOKEN", "one-time-secret")
    monkeypatch.setenv("ATALK_ACTIVATION_TOKEN", "other-secret")
    manager.launch(release)
    assert "ATALK_AGENT_TOKEN" not in captured["environment"]
    assert "ATALK_ACTIVATION_TOKEN" not in captured["environment"]
    assert captured["environment"]["ATALK_CREDENTIAL_PATH"] == str(manager.paths.credential)


def test_health_endpoint_requires_2xx_and_connected_state():
    class Response:
        def __init__(self, status, body=b""):
            self.status = status
            self.body = body

        def read(self, _limit):
            return self.body

    assert _health_response_is_ready(Response(204)) is True
    assert _health_response_is_ready(Response(404)) is False
    assert _health_response_is_ready(Response(200, b'{"connected":true}')) is True
    assert _health_response_is_ready(Response(200, b'{"connected":false}')) is False
    assert _health_response_is_ready(Response(200, b'{"ok":false}')) is False


def test_health_endpoint_must_survive_startup_probation(tmp_path, monkeypatch):
    class Response:
        status = 200

        def read(self, _limit):
            return b'{"connected":true}'

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    moments = [0.0, 0.0, 0.0, 0.0, 0.06, 0.06, 0.06]
    requests = []
    monkeypatch.setattr(
        "atalk.runtime_manager.time.monotonic",
        lambda: moments.pop(0) if moments else 0.06,
    )
    monkeypatch.setattr("atalk.runtime_manager.time.sleep", lambda _seconds: None)
    monkeypatch.setattr(
        "atalk.runtime_manager.urlopen",
        lambda request, **_kwargs: requests.append(request) or Response(),
    )
    manager = make_manager(
        tmp_path,
        health_url="http://127.0.0.1:8080/health",
        health_grace_seconds=0.05,
        health_timeout_seconds=0.1,
    )

    assert manager.health_check(FakeProcess()) is True
    assert len(requests) == 2
