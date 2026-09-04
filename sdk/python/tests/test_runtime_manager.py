from __future__ import annotations

import base64
import contextlib
import io
import json
import hashlib
import os
import signal
import subprocess
import sys
import time
import uuid
import zipfile
from dataclasses import replace
from datetime import datetime
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
    ReconcileResult,
    RuntimeManager,
    RuntimeManagerError,
    UpdateStatus,
    _exclusive_lock,
    _health_response_is_ready,
    _launch_with_parent_watchdog,
    _pid_exists,
    _release_tree_digest,
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


def wheel_fixture(distribution, version="0.1.0a11"):
    output = io.BytesIO()
    normalized = distribution.replace("-", "_")
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(
            f"{normalized}-{version}.dist-info/METADATA",
            f"Metadata-Version: 2.1\nName: {distribution}\nVersion: {version}\n\n",
        )
    return output.getvalue()


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


def write_credentials(manager, peer_id="peer-1"):
    manager.paths.credential.parent.mkdir(parents=True, exist_ok=True)
    manager.paths.credential.write_text(json.dumps({"peer": {"id": peer_id}}))
    os.chmod(manager.paths.credential, 0o600)


def write_release_fixture(manager, version="0.1.0a11"):
    release = manager._release_from_path(version, manager.paths.releases / version)
    release.site_packages.mkdir(parents=True)
    os.chmod(release.path, 0o700)
    distribution = release.site_packages / f"atalk_sdk-{version}.dist-info"
    distribution.mkdir()
    (distribution / "METADATA").write_text(
        f"Metadata-Version: 2.1\nName: atalk-sdk\nVersion: {version}\n\n"
    )
    (release.site_packages / "atalk.py").write_text("VALUE = 1\n")
    executable = release.path / "bin" / "python"
    executable.parent.mkdir()
    executable.write_text("#!/bin/sh\nexit 99\n")
    executable.chmod(0o755)
    artifacts = {f"atalk_sdk-{version}-py3-none-any.whl": "a" * 64}
    marker = {
        "version": 1,
        "stack": "python",
        "release": version,
        "packages": [f"atalk-sdk=={version}"],
        "registry": "https://pypi.org/simple",
        "artifacts": artifacts,
        "resolved": {"atalk-sdk": version},
        "treeSha256": _release_tree_digest(release.path),
    }
    (release.path / "release.json").write_text(json.dumps(marker))
    os.chmod(release.path / "release.json", 0o600)
    return release


def update_status(
    policy="COMPATIBLE", severity="INFO", status="UPDATE_AVAILABLE", recommended="0.1.0a12",
    checked_at="2026-09-04T12:00:00.000Z",
):
    parsed = parse_runtime_update_advisory({
        "status": status,
        "currentVersion": "0.1.0a11",
        "recommendedVersion": recommended,
        "minimumVersion": "0.1.0a10",
        "severity": severity,
        "policy": policy,
        "checkedAt": checked_at,
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
        writer_peer_id="peer-1",
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


def test_profile_lock_rejects_symbolic_links(tmp_path):
    target = tmp_path / "unrelated"
    target.write_text("do not chmod or lock me")
    link = tmp_path / "manager.lock"
    link.symlink_to(target)
    with pytest.raises(RuntimeManagerError, match="symbolic link"):
        with _exclusive_lock(link):
            pass


@pytest.mark.skipif(os.name != "posix", reason="managed process replacement is POSIX-only")
def test_parent_death_pipe_kills_managed_process_group(tmp_path):
    lock = tmp_path / "manager.lock"
    child_ready = tmp_path / "child-ready"
    child_code = (
        "import signal,time; from pathlib import Path; "
        "signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        f"Path({str(child_ready)!r}).write_text('ready'); time.sleep(60)"
    )
    owner_code = "\n".join([
        "import os, sys, time",
        "from pathlib import Path",
        "from atalk.runtime_manager import _exclusive_lock, _launch_with_parent_watchdog",
        f"with _exclusive_lock(Path({str(lock)!r})) as lock_descriptor:",
        "    process = _launch_with_parent_watchdog(",
        f"        [sys.executable, '-c', {child_code!r}],",
        "        cwd=None, environment=os.environ.copy(), shutdown_timeout_seconds=1.0,",
        "        lock_descriptor=lock_descriptor,",
        "    )",
        f"    ready = Path({str(child_ready)!r})",
        "    while not ready.exists(): time.sleep(0.01)",
        "    print(process.pid, flush=True)",
        "    time.sleep(60)",
    ])
    owner = subprocess.Popen(
        [sys.executable, "-c", owner_code],
        cwd=tmp_path,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    assert owner.stdout is not None
    line = owner.stdout.readline().strip()
    if not line:
        stderr = owner.stderr.read() if owner.stderr else ""
        pytest.fail(f"watchdog owner failed to launch: {stderr}")
    child_pid = int(line)
    assert _pid_exists(child_pid)

    os.kill(owner.pid, signal.SIGKILL)
    owner.wait(timeout=2)
    with pytest.raises(RuntimeManagerError, match="already owns"):
        with _exclusive_lock(lock):
            pass
    deadline = time.monotonic() + 5
    while _pid_exists(child_pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    assert not _pid_exists(child_pid)
    lock_deadline = time.monotonic() + 2
    while True:
        try:
            with _exclusive_lock(lock):
                break
        except RuntimeManagerError:
            if time.monotonic() >= lock_deadline:
                raise
            time.sleep(0.01)


@pytest.mark.skipif(os.name != "posix", reason="managed process replacement is POSIX-only")
def test_watchdog_cleans_same_group_descendant_after_leader_exits(tmp_path):
    descendant_path = tmp_path / "descendant-pid"
    leader_code = (
        "import subprocess,sys; from pathlib import Path; "
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
        f"Path({str(descendant_path)!r}).write_text(str(child.pid))"
    )
    watched = _launch_with_parent_watchdog(
        [sys.executable, "-c", leader_code],
        cwd=tmp_path,
        environment=os.environ.copy(),
        shutdown_timeout_seconds=0.2,
        lock_descriptor=None,
    )
    descendant_pid = None
    try:
        assert watched.wait(timeout=5) == 0
        descendant_pid = int(descendant_path.read_text())
        assert not _pid_exists(descendant_pid)
    finally:
        if descendant_pid and _pid_exists(descendant_pid):
            with contextlib.suppress(ProcessLookupError):
                os.kill(descendant_pid, signal.SIGKILL)


def test_stale_live_pid_is_never_signaled_or_duplicated(tmp_path):
    manager = make_manager(tmp_path)
    manager._prepare_private_directories()
    manager.paths.state.write_text(json.dumps({
        "version": 1,
        "status": "RUNNING",
        "release": "0.1.0a11",
        "pid": os.getpid(),
    }))
    os.chmod(manager.paths.state, 0o600)
    with pytest.raises(RuntimeManagerError, match="possibly reused PID"):
        manager._recover_stale_runtime()


def test_stage_downloads_exact_allowlisted_pins_and_verifies_pypi_hashes(tmp_path, monkeypatch):
    wheel_names = {
        "atalk-sdk": "atalk_sdk-0.1.0a11-py3-none-any.whl",
        "atalk-hermes": "atalk_hermes-0.1.0a11-py3-none-any.whl",
    }
    wheel_bytes = {package: wheel_fixture(package) for package in wheel_names}
    digests = {package: hashlib.sha256(value).hexdigest() for package, value in wheel_bytes.items()}
    commands = []

    def fake_venv_create(_builder, path):
        (Path(path) / "bin").mkdir(parents=True)
        (Path(path) / "bin" / "python").write_text("fixture")

    def runner(command, **_kwargs):
        commands.append(command)
        if "download" in command:
            destination = Path(command[command.index("--dest") + 1])
            for package, filename in wheel_names.items():
                (destination / filename).write_bytes(wheel_bytes[package])
        return type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()

    def hashes(package, _version):
        normalized = package.replace("_", "-")
        filename = wheel_names[normalized]
        return {filename: digests[normalized]}

    manager = make_manager(tmp_path, command_runner=runner, artifact_hash_fetcher=hashes)
    manager._prepare_private_directories()
    stale = manager.paths.releases / "0.1.0a11"
    stale.mkdir()
    (stale / "attacker-controlled").write_text("must not be reused")
    manager.verify = lambda _release: None
    monkeypatch.setattr("atalk.runtime_manager.venv.EnvBuilder.create", fake_venv_create)
    monkeypatch.setattr("atalk.runtime_manager._verify_installed_distributions", lambda *_args: None)
    release = manager.stage("0.1.0a11")

    assert release.version == "0.1.0a11"
    assert not (release.path / "attacker-controlled").exists()
    assert commands[0][-2:] == ["atalk-sdk==0.1.0a11", "atalk-hermes==0.1.0a11"]
    assert "download" in commands[0]
    assert "--index-url" in commands[0]
    assert commands[0][commands[0].index("--index-url") + 1] == "https://pypi.org/simple"
    assert "install" in commands[1]
    assert "--no-index" in commands[1]
    marker = json.loads((release.path / "release.json").read_text())
    assert marker["packages"] == ["atalk-sdk==0.1.0a11", "atalk-hermes==0.1.0a11"]
    assert marker["artifacts"] == {
        wheel_names[package]: digests[package] for package in sorted(wheel_names)
    }
    assert marker["resolved"] == {"atalk-hermes": "0.1.0a11", "atalk-sdk": "0.1.0a11"}
    assert len(marker["treeSha256"]) == 64


def test_tampered_download_hash_is_rejected(tmp_path):
    manager = make_manager(
        tmp_path,
        artifact_hash_fetcher=lambda _package, _version: {
            "atalk_sdk-0.1.0a11-py3-none-any.whl": "0" * 64,
        },
    )
    wheelhouse = tmp_path / "wheels"
    wheelhouse.mkdir()
    (wheelhouse / "atalk_sdk-0.1.0a11-py3-none-any.whl").write_bytes(wheel_fixture("atalk-sdk"))
    with pytest.raises(RuntimeManagerError, match="SHA-256"):
        manager._verify_downloaded_wheels(wheelhouse)


def test_release_verification_uses_trusted_manifest_without_executing_candidate(tmp_path):
    manager = make_manager(tmp_path, stack="python")
    manager._prepare_private_directories()
    release = write_release_fixture(manager)

    manager.verify(release)
    (release.site_packages / "atalk.py").write_text("VALUE = 'tampered'\n")
    with pytest.raises(RuntimeManagerError, match="trusted manifest"):
        manager.verify(release)


def test_launch_revalidates_release_before_process_creation(tmp_path):
    created = []
    manager = make_manager(
        tmp_path,
        stack="python",
        process_factory=lambda *_args, **_kwargs: created.append(True) or FakeProcess(),
    )
    manager._prepare_private_directories()
    write_credentials(manager)
    release = write_release_fixture(manager)
    (release.site_packages / "atalk.py").write_text("VALUE = 'changed-after-stage'\n")

    with pytest.raises(RuntimeManagerError, match="trusted manifest"):
        manager.launch(release)
    assert created == []


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


def test_only_fresh_status_from_the_current_managed_launch_is_actionable(tmp_path):
    now = datetime.fromisoformat("2026-09-04T12:00:00+00:00").timestamp()
    manager = make_manager(tmp_path, clock=lambda: now)
    process = FakeProcess()
    launch_id = str(uuid.uuid4())
    manager._process_launch_ids[process.pid] = launch_id
    manager._process_versions[process.pid] = "0.1.0a11"
    manager._process_peer_ids[process.pid] = "peer-1"
    manager._process_started_at[process.pid] = now
    metadata = resolve_runtime_check_in(RuntimeOptions(
        integration=RuntimeComponent("atalk-hermes", "0.1.0a11"),
        capabilities=["runtime.auto-update"],
    )).to_wire()
    current = update_status(checked_at="2026-09-04T12:00:00.000Z")
    status = UpdateStatus(metadata, current, process.pid, launch_id, "peer-1")

    assert manager._status_is_actionable(status, process, "0.1.0a11") is True
    assert manager._status_is_actionable(
        replace(status, advisory=replace(current, checked_at="2026-09-03T23:59:59.000Z")),
        process,
        "0.1.0a11",
    ) is False
    assert manager._status_is_actionable(
        replace(status, advisory=replace(current, checked_at="2026-09-04T12:05:01.000Z")),
        process,
        "0.1.0a11",
    ) is False
    assert manager._status_is_actionable(replace(status, writer_launch_id=str(uuid.uuid4())), process, "0.1.0a11") is False
    assert manager._status_is_actionable(replace(status, writer_process_id=process.pid + 1), process, "0.1.0a11") is False
    assert manager._status_is_actionable(replace(status, writer_peer_id="another-peer"), process, "0.1.0a11") is False
    process.alive = False
    process.returncode = 1
    assert manager._status_is_actionable(status, process, "0.1.0a11") is False


def test_python_health_uses_sdk_release_even_when_custom_integration_has_its_own_version(tmp_path):
    now = datetime.fromisoformat("2026-09-04T12:00:00+00:00").timestamp()
    manager = make_manager(tmp_path, stack="python", clock=lambda: now)
    process = FakeProcess()
    launch_id = str(uuid.uuid4())
    manager._process_launch_ids[process.pid] = launch_id
    manager._process_versions[process.pid] = "0.1.0a11"
    manager._process_peer_ids[process.pid] = "peer-1"
    manager._process_started_at[process.pid] = now
    metadata = resolve_runtime_check_in(RuntimeOptions(
        integration=RuntimeComponent("custom", "7.4.2"),
        capabilities=["runtime.auto-update"],
    )).to_wire()
    # When the SDK is current, the server may report the unknown custom
    # integration as the determining advisory. That still proves health, but
    # it must not be mistaken for an SDK update decision.
    status = UpdateStatus(
        metadata,
        replace(update_status(), current_version="7.4.2", status="UNKNOWN", recommended_version=None),
        process.pid,
        launch_id,
        "peer-1",
    )
    assert manager._status_is_from_current_launch(status, process, "0.1.0a11") is True
    assert manager._status_is_actionable(status, process, "0.1.0a11") is False


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


def test_candidate_pointer_is_committed_only_after_health(tmp_path):
    manager = make_manager(tmp_path)
    manager._prepare_private_directories()
    previous = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    previous_process = FakeProcess()
    candidate_process = FakeProcess()
    manager._write_pointer(previous)
    manager.stage = lambda _version: candidate
    manager.stop_process = lambda process: setattr(process, "alive", False)
    manager.launch = lambda _release: candidate_process

    def health(_process):
        transition = json.loads(manager.paths.state.read_text())
        assert json.loads(manager.paths.pointer.read_text())["release"] == previous.version
        assert transition["status"] == "SWITCHING"
        assert transition["targetRelease"] == candidate.version
        return True

    manager.health_check = health
    result = manager.reconcile(previous_process, previous, candidate.version)

    assert result.updated is True
    assert json.loads(manager.paths.pointer.read_text())["release"] == candidate.version


def test_startup_recovers_and_quarantines_incomplete_switch(tmp_path):
    manager = make_manager(tmp_path)
    manager._prepare_private_directories()
    previous = ManagedRelease(
        "0.1.0a11", manager.paths.releases / "0.1.0a11", tmp_path / "unused",
    )
    candidate_version = "0.1.0a12"
    previous.path.mkdir()
    manager.verify = lambda release: None
    manager._write_pointer(previous)
    manager._write_state(
        "SWITCHING", previous, 999_999,
        detail=f"target={candidate_version}", target_release=candidate_version,
    )

    manager._recover_stale_runtime()

    pointer = json.loads(manager.paths.pointer.read_text())
    state = json.loads(manager.paths.state.read_text())
    failure = manager.update_deferment(candidate_version, include_expired=True)
    assert pointer["release"] == previous.version
    assert state["status"] == "ROLLED_BACK"
    assert failure is not None
    assert failure.category == "CANDIDATE"
    assert failure.quarantined is True


def test_unhealthy_rollback_is_stopped_and_reported_as_failure(tmp_path):
    manager = make_manager(tmp_path, clock=lambda: 1_800_000_000.0)
    manager._prepare_private_directories()
    old = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    original = FakeProcess()
    launched = []
    stopped = []
    manager.stage = lambda _version: candidate

    def launch(_release):
        process = FakeProcess()
        launched.append(process)
        return process

    def stop(process):
        stopped.append(process.pid)
        process.alive = False
        process.returncode = 1

    manager.launch = launch
    manager.stop_process = stop
    manager.health_check = lambda _process: False
    with pytest.raises(RuntimeManagerError, match="remained unhealthy"):
        manager.reconcile(original, old, "0.1.0a12")
    assert launched[-1].pid in stopped
    assert manager.update_deferment("0.1.0a12") is not None


def test_runtime_restart_retries_with_backoff_until_health_recovers(tmp_path):
    manager = make_manager(tmp_path)
    manager._prepare_private_directories()
    release = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    processes = [FakeProcess(), FakeProcess()]
    health = iter([False, True])
    stopped = []
    delays = []
    manager.launch = lambda _release: processes.pop(0)
    manager.health_check = lambda _process: next(health)
    manager.stop_process = lambda process: stopped.append(process.pid)
    manager._interruptible_sleep = delays.append

    recovered = manager._restart_until_healthy(release, reason="test_failure")
    assert recovered is not None
    assert stopped
    assert delays == [2]
    state = json.loads(manager.paths.state.read_text())
    assert state["status"] == "RUNNING"
    assert state["detail"] == "recovered_after=1; reason=test_failure"


def test_monitored_rollback_quarantines_before_restore_launch(tmp_path):
    manager = make_manager(tmp_path, clock=lambda: 1_800_000_000.0)
    manager._prepare_private_directories()
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    previous = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    process = FakeProcess()
    observed = []
    record = manager._record_update_failure

    def record_before_launch(*args):
        observed.append("quarantine")
        return record(*args)

    manager.stop_process = lambda _process: observed.append("stop")
    manager._record_update_failure = record_before_launch
    manager.launch = lambda _release: observed.append("launch") or (_ for _ in ()).throw(
        RuntimeManagerError("restore unavailable")
    )
    with pytest.raises(RuntimeManagerError, match="restore unavailable"):
        manager._rollback_monitored_candidate(process, candidate, previous)
    assert observed == ["stop", "quarantine", "launch"]
    assert manager.update_deferment(candidate.version) is not None


def test_post_activation_exit_rolls_back_instead_of_relaunching_candidate(tmp_path, monkeypatch):
    manager = make_manager(tmp_path, clock=lambda: 1_800_000_000.0)
    write_credentials(manager)
    previous = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    candidate = ManagedRelease("0.1.0a12", tmp_path / "candidate", tmp_path / "candidate" / "site")
    previous_process = FakeProcess()
    candidate_process = FakeProcess()
    restored_process = FakeProcess()
    restart_calls = []
    rollback_calls = []

    manager._load_current_release = lambda: previous
    manager._restart_until_healthy = lambda release, **kwargs: (
        restart_calls.append((release, kwargs["reason"])) or previous_process
    )
    manager.health_snapshot = lambda _process: True
    status = UpdateStatus({}, update_status(), previous_process.pid, str(uuid.uuid4()), "peer-1")
    statuses = iter([status, None])
    manager.read_update_status = lambda: next(statuses)
    manager._status_is_actionable = lambda *_args: True
    manager.should_auto_update = lambda *_args: True
    manager.update_deferment = lambda *_args, **_kwargs: None
    manager.reconcile = lambda *_args: ReconcileResult(
        candidate_process, candidate, updated=True, rolled_back=False,
    )

    def rollback(process, release, fallback):
        rollback_calls.append((process, release, fallback))
        return restored_process, fallback

    manager._rollback_monitored_candidate = rollback
    manager.stop_process = lambda process: setattr(process, "alive", False)
    sleeps = []

    def sleep(_seconds):
        sleeps.append(True)
        if len(sleeps) == 1:
            candidate_process.alive = False
            candidate_process.returncode = 17
        else:
            manager._stopping = True

    monkeypatch.setattr("atalk.runtime_manager.time.sleep", sleep)

    assert manager.run() == 0
    assert restart_calls == [(previous, "initial_start")]
    assert rollback_calls == [(candidate_process, candidate, previous)]


def test_run_skips_quarantined_candidate_without_interrupting_previous_runtime(tmp_path, monkeypatch):
    now = [1_800_000_000.0]
    manager = make_manager(tmp_path, clock=lambda: now[0])
    write_credentials(manager)
    write_status(manager)
    manager._record_update_failure(
        "0.1.0a12", "CANDIDATE", "candidate_health_or_switch_failed",
    )
    current = ManagedRelease("0.1.0a11", tmp_path / "old", tmp_path / "old" / "site")
    process = FakeProcess()
    launch_id = str(uuid.uuid4())
    value = json.loads(manager.paths.update_status.read_text())
    value["writerProcessId"] = process.pid
    value["writerLaunchId"] = launch_id
    value["writerPeerId"] = "peer-1"
    value["advisory"]["checkedAt"] = "2027-01-15T08:00:00.000Z"
    manager.paths.update_status.write_text(json.dumps(value))
    os.chmod(manager.paths.update_status, 0o600)
    manager._process_launch_ids[process.pid] = launch_id
    manager._process_versions[process.pid] = "0.1.0a11"
    manager._process_peer_ids[process.pid] = "peer-1"
    manager._process_started_at[process.pid] = now[0]
    manager._load_current_release = lambda: current
    manager.launch = lambda _release: process
    manager.health_check = lambda _process: True
    manager.health_snapshot = lambda _process: True
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
    manager.verify = lambda _release: None
    with pytest.raises(RuntimeManagerError, match="Pair this agent once"):
        manager.launch(release)
    write_credentials(manager)
    monkeypatch.setenv("ATALK_AGENT_TOKEN", "one-time-secret")
    monkeypatch.setenv("ATALK_ACTIVATION_TOKEN", "other-secret")
    manager.launch(release)
    assert "ATALK_AGENT_TOKEN" not in captured["environment"]
    assert "ATALK_ACTIVATION_TOKEN" not in captured["environment"]
    assert captured["environment"]["ATALK_CREDENTIAL_PATH"] == str(manager.paths.credential)
    launch_id = captured["environment"]["ATALK_RUNTIME_LAUNCH_ID"]
    assert str(uuid.UUID(launch_id)) == launch_id
    assert manager._process_launch_ids[FakeProcess.next_pid - 1] == launch_id
    assert manager._process_peer_ids[FakeProcess.next_pid - 1] == "peer-1"


def test_health_endpoint_requires_2xx_and_connected_state():
    class Response:
        def __init__(self, status, body=b""):
            self.status = status
            self.body = body

        def read(self, _limit):
            return self.body

    def ready(body, status=200, **overrides):
        return _health_response_is_ready(
            Response(status, json.dumps(body).encode()),
            expected_process_id=123,
            expected_version="0.1.0a11",
            expected_peer_id="peer-1",
            stack="hermes",
            **overrides,
        )

    body = {
        "status": "ok",
        "connected": True,
        "identity": {"id": "peer-1"},
        "runtime": {
            "processId": 123,
            "metadata": {
                "sdk": {"name": "atalk-sdk", "version": "0.1.0a11"},
                "integration": {"name": "atalk-hermes", "version": "0.1.0a11"},
            },
        },
    }
    assert ready(body) is True
    assert ready(body, status=404) is False
    assert ready({**body, "connected": False}) is False
    assert ready({**body, "identity": {"id": "other-peer"}}) is False
    assert ready({**body, "runtime": {**body["runtime"], "processId": 999}}) is False
    wrong_version = json.loads(json.dumps(body))
    wrong_version["runtime"]["metadata"]["integration"]["version"] = "0.1.0a10"
    assert ready(wrong_version) is False


def test_health_endpoint_must_survive_startup_probation(tmp_path, monkeypatch):
    moments = [0.0, 0.0, 0.0, 0.01, 0.01, 0.06, 0.06]
    monkeypatch.setattr(
        "atalk.runtime_manager.time.monotonic",
        lambda: moments.pop(0) if moments else 0.06,
    )
    monkeypatch.setattr("atalk.runtime_manager.time.sleep", lambda _seconds: None)
    manager = make_manager(
        tmp_path,
        health_grace_seconds=0.05,
        health_timeout_seconds=0.1,
    )
    observations = []
    manager.health_snapshot = lambda process, **_kwargs: observations.append(process.pid) or True
    assert manager.health_check(FakeProcess()) is True
    assert len(observations) == 3
