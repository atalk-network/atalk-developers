"""Opt-in, external supervisor for safe aTalk Python connector updates.

The manager consumes the SDK's private advisory sidecar. It never evaluates a
server-supplied command: package names, registry, process command and health
probe all come from this local program/configuration.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import errno
from email.parser import BytesParser
from email.policy import compat32
import hashlib
import hmac
import importlib.metadata
import json
import os
import re
import select
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
import venv
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Sequence
from urllib.request import Request, urlopen
from urllib.parse import quote

from .runtime_update import RuntimeUpdateAdvisory, parse_runtime_update_advisory


PYPI_INDEX = "https://pypi.org/simple"
PYPI_PUBLISH_ATTESTATION = "https://docs.pypi.org/attestations/publish/v1"
OFFICIAL_PUBLISHER = {
    "environment": "pypi",
    "kind": "GitHub",
    "repository": "atalk-network/atalk-developers",
    "workflow": "release-python.yml",
}
MAX_STATUS_BYTES = 64 * 1024
MAX_TRACKED_UPDATE_FAILURES = 32
MAX_ADVISORY_AGE_SECONDS = 12 * 60 * 60
MAX_ADVISORY_FUTURE_SKEW_SECONDS = 5 * 60
MAX_RELEASE_MANIFEST_BYTES = 4 * 1024 * 1024
MIN_HEALTH_OBSERVATIONS = 3
MAX_MONITOR_FAILURES = 3
POST_ACTIVATION_ROLLBACK_SECONDS = 5 * 60
WATCHDOG_CLEANUP_SLACK_SECONDS = 2.0
RUNTIME_RESTART_BACKOFF_SECONDS = (2, 5, 15, 60, 5 * 60)
STAGING_BACKOFF_SECONDS = (5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60)
CANDIDATE_BACKOFF_SECONDS = (6 * 60 * 60, 24 * 60 * 60, 3 * 24 * 60 * 60, 7 * 24 * 60 * 60)
PACKAGE_STACKS: dict[str, tuple[str, ...]] = {
    "python": ("atalk-sdk",),
    "hermes": ("atalk-sdk", "atalk-hermes"),
}
INTEGRATION_NAMES: dict[str, frozenset[str]] = {
    "python": frozenset({"custom", "atalk-sdk", "sdk-python"}),
    "hermes": frozenset({"atalk-hermes", "atalk_hermes", "hermes-plugin"}),
}
_VERSION_PATTERN = re.compile(
    r"^(?P<release>(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*)(?:(?P<pre>a|b|rc)(?P<pre_n>0|[1-9]\d*))?$"
)
_PROFILE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class RuntimeManagerError(RuntimeError):
    pass


@dataclass(frozen=True)
class ManagedRelease:
    version: str
    path: Path
    site_packages: Path


@dataclass(frozen=True)
class RuntimeManagerPaths:
    root: Path
    releases: Path
    pointer: Path
    state: Path
    attempts: Path
    lock: Path
    update_status: Path
    credential: Path


@dataclass(frozen=True)
class UpdateStatus:
    metadata: dict[str, Any]
    advisory: RuntimeUpdateAdvisory
    writer_process_id: int | None = None
    writer_launch_id: str | None = None
    writer_peer_id: str | None = None


@dataclass(frozen=True)
class ReconcileResult:
    process: ManagedProcess
    release: ManagedRelease
    updated: bool
    rolled_back: bool


@dataclass(frozen=True)
class UpdateFailure:
    target_version: str
    category: Literal["STAGING", "CANDIDATE"]
    reason: str
    failures: int
    failed_at: str
    next_retry_at: str
    quarantined: bool

    def to_wire(self) -> dict[str, Any]:
        return {
            "targetVersion": self.target_version,
            "category": self.category,
            "reason": self.reason,
            "failures": self.failures,
            "failedAt": self.failed_at,
            "nextRetryAt": self.next_retry_at,
            "quarantined": self.quarantined,
        }


CommandRunner = Callable[..., subprocess.CompletedProcess[str]]
ProcessFactory = Callable[..., subprocess.Popen[bytes]]
ArtifactHashFetcher = Callable[[str, str], dict[str, str]]


class _WatchedProcess:
    """Popen-compatible view of a child owned by the parent-death watchdog."""

    def __init__(self, pid: int, watchdog: subprocess.Popen[bytes], keepalive_descriptor: int):
        self.pid = pid
        self._watchdog = watchdog
        self._keepalive_descriptor = keepalive_descriptor

    @property
    def returncode(self) -> int | None:
        return self._watchdog.returncode

    def poll(self) -> int | None:
        result = self._watchdog.poll()
        if result is not None:
            self.close_keepalive()
        return result

    def wait(self, timeout: float | None = None) -> int:
        try:
            return self._watchdog.wait(timeout=timeout)
        finally:
            self.close_keepalive()

    def close_keepalive(self) -> None:
        if self._keepalive_descriptor < 0:
            return
        descriptor = self._keepalive_descriptor
        self._keepalive_descriptor = -1
        with contextlib.suppress(OSError):
            os.close(descriptor)


ManagedProcess = subprocess.Popen[bytes] | _WatchedProcess


class RuntimeManager:
    def __init__(
        self,
        *,
        stack: Literal["python", "hermes"],
        profile: str,
        initial_version: str,
        credential_path: str | Path,
        command: Sequence[str],
        root: str | Path | None = None,
        update_status_path: str | Path | None = None,
        working_directory: str | Path | None = None,
        health_url: str | None = None,
        health_grace_seconds: float = 8.0,
        health_timeout_seconds: float = 30.0,
        poll_interval_seconds: float = 15.0,
        shutdown_timeout_seconds: float = 10.0,
        update_ceiling: Literal["NOTIFY", "SECURITY", "COMPATIBLE"] = "COMPATIBLE",
        command_runner: CommandRunner = subprocess.run,
        process_factory: ProcessFactory | None = None,
        artifact_hash_fetcher: ArtifactHashFetcher | None = None,
        clock: Callable[[], float] = time.time,
    ):
        if stack not in PACKAGE_STACKS:
            raise ValueError(f"Unsupported runtime stack: {stack}")
        if not _PROFILE_PATTERN.fullmatch(profile):
            raise ValueError("Profile must be a simple 1-64 character identifier")
        _validate_version(initial_version)
        if not command or not command[0]:
            raise ValueError("A local runtime command is required after --")
        if health_grace_seconds < 0 or health_timeout_seconds <= 0 or poll_interval_seconds <= 0:
            raise ValueError("Health and polling intervals must be positive")
        if update_ceiling not in {"NOTIFY", "SECURITY", "COMPATIBLE"}:
            raise ValueError("Update ceiling must be NOTIFY, SECURITY or COMPATIBLE")
        base = Path(root or "~/.atalk/runtime-manager").expanduser().resolve() / profile
        credential = _absolute_path(credential_path)
        releases = base / "releases"
        try:
            credential.resolve(strict=False).relative_to(releases)
        except ValueError:
            pass
        else:
            raise ValueError("Credentials must live outside versioned runtime environments")
        status = _absolute_path(update_status_path) if update_status_path else Path(
            f"{credential}.update.json"
        )
        self.paths = RuntimeManagerPaths(
            root=base,
            releases=releases,
            pointer=base / "current.json",
            state=base / "manager-state.json",
            attempts=base / "update-attempts.json",
            lock=base / "manager.lock",
            update_status=status,
            credential=credential,
        )
        self.stack = stack
        self.initial_version = initial_version
        self.command = tuple(command)
        self.working_directory = Path(working_directory).expanduser().resolve() if working_directory else None
        self.health_url = _validate_health_url(health_url)
        self.health_grace_seconds = health_grace_seconds
        self.health_timeout_seconds = health_timeout_seconds
        self.poll_interval_seconds = poll_interval_seconds
        self.shutdown_timeout_seconds = shutdown_timeout_seconds
        self.update_ceiling = update_ceiling
        self._command_runner = command_runner
        self._process_factory = process_factory
        self._artifact_hash_fetcher = artifact_hash_fetcher or _pypi_release_hashes
        self._clock = clock
        self._stopping = False
        self._process_launch_ids: dict[int, str] = {}
        self._process_versions: dict[int, str] = {}
        self._process_peer_ids: dict[int, str] = {}
        self._process_started_at: dict[int, float] = {}
        self._lock_descriptor: int | None = None

    def run(self) -> int:
        if os.name != "posix":
            raise RuntimeManagerError(
                "The managed Python/Hermes Runtime Manager currently requires macOS or Linux"
            )
        self._prepare_private_directories()
        self._validate_paired_credentials()
        with _exclusive_lock(self.paths.lock) as lock_descriptor, _termination_handlers(self):
            self._lock_descriptor = lock_descriptor
            try:
                self._recover_stale_runtime()
                pointer_version = self._load_pointer_version() or self.initial_version
                release = self._load_current_release()
                if release is None:
                    release = self.stage(pointer_version)
                self._write_pointer(release)
                process = self._restart_until_healthy(release, reason="initial_start")
                if process is None:
                    self._write_state("STOPPED", release, None)
                    return 0
                monitor_failures = 0
                rollback_release: ManagedRelease | None = None
                rollback_deadline = 0.0
                try:
                    while not self._stopping:
                        runtime_failure: str | None = None
                        if process.poll() is not None:
                            runtime_failure = f"exit={process.returncode}"
                        elif not self.health_snapshot(process):
                            monitor_failures += 1
                            if monitor_failures >= MAX_MONITOR_FAILURES:
                                runtime_failure = "runtime_health_lost"
                        else:
                            monitor_failures = 0
                            if rollback_release and self._clock() > rollback_deadline:
                                rollback_release = None
                                rollback_deadline = 0.0
                        if runtime_failure:
                            if rollback_release and self._clock() <= rollback_deadline:
                                try:
                                    process, release = self._rollback_monitored_candidate(
                                        process, release, rollback_release,
                                    )
                                except RuntimeManagerError:
                                    release = rollback_release
                                    replacement = self._restart_until_healthy(
                                        release, reason="post_activation_rollback_failed",
                                    )
                                    if replacement is None:
                                        break
                                    process = replacement
                                rollback_release = None
                                rollback_deadline = 0.0
                            else:
                                self._write_state(
                                    "RESTARTING", release,
                                    process.pid if process.poll() is None else None,
                                    detail=runtime_failure,
                                )
                                self.stop_process(process)
                                replacement = self._restart_until_healthy(
                                    release, reason=runtime_failure,
                                )
                                if replacement is None:
                                    break
                                process = replacement
                            monitor_failures = 0
                        update = self.read_update_status()
                        if (
                            update
                            and self._status_is_actionable(update, process, release.version)
                            and self.should_auto_update(update, release.version)
                        ):
                            target_version = update.advisory.recommended_version or ""
                            deferred = self.update_deferment(target_version)
                            if deferred:
                                self._write_state(
                                    "UPDATE_DEFERRED", release, process.pid, update_failure=deferred,
                                )
                                time.sleep(self.poll_interval_seconds)
                                continue
                            previous_release = release
                            try:
                                result = self.reconcile(process, release, target_version)
                                process, release = result.process, result.release
                                if result.updated:
                                    rollback_release = previous_release
                                    rollback_deadline = self._clock() + POST_ACTIVATION_ROLLBACK_SECONDS
                            except RuntimeManagerError as error:
                                # A registry/staging failure leaves the current process untouched.
                                # A failed rollback only reaches here if the prior process could not
                                # be relaunched, in which case the monitor exits explicitly.
                                if process.poll() is not None:
                                    replacement = self._restart_until_healthy(
                                        release, reason="update_rollback_failed",
                                    )
                                    if replacement is None:
                                        break
                                    process = replacement
                                else:
                                    failure = self.update_deferment(target_version, include_expired=True)
                                    self._write_state(
                                        "UPDATE_DEFERRED", release, process.pid,
                                        detail=type(error).__name__, update_failure=failure,
                                    )
                        time.sleep(self.poll_interval_seconds)
                except KeyboardInterrupt:
                    self._stopping = True
                finally:
                    self.stop_process(process)
                    self._write_state("STOPPED", release, None)
            finally:
                self._lock_descriptor = None
        return 0

    def stage(self, version: str) -> ManagedRelease:
        _validate_version(version)
        final = self.paths.releases / version
        temporary = self.paths.releases / f".stage-{version}-{uuid.uuid4().hex}"
        try:
            venv.EnvBuilder(with_pip=True, clear=False, symlinks=os.name != "nt").create(temporary)
            os.chmod(temporary, 0o700)
            release = self._release_from_path(version, temporary)
            pins = self.package_pins(version)
            wheelhouse = temporary / "wheelhouse"
            wheelhouse.mkdir(mode=0o700)
            download_command = [
                str(_venv_python(temporary)), "-I", "-m", "pip", "--isolated", "download",
                "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
                "--dest", str(wheelhouse), "--index-url", PYPI_INDEX, *pins,
            ]
            completed = self._command_runner(
                download_command,
                cwd=temporary,
                env=_sanitized_install_environment(),
                text=True,
                capture_output=True,
                check=False,
            )
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "pip failed").strip()[-2000:]
                raise RuntimeManagerError(f"Could not stage aTalk {version}: {detail}")
            artifacts = self._verify_downloaded_wheels(wheelhouse)
            resolved = _resolved_wheel_graph(artifacts)
            install_command = [
                str(_venv_python(temporary)), "-I", "-m", "pip", "--isolated", "install",
                "--disable-pip-version-check", "--no-input", "--only-binary=:all:",
                "--no-index", "--find-links", str(wheelhouse), *pins,
            ]
            completed = self._command_runner(
                install_command,
                cwd=temporary,
                env=_sanitized_install_environment(),
                text=True,
                capture_output=True,
                check=False,
            )
            if completed.returncode != 0:
                detail = (completed.stderr or completed.stdout or "pip failed").strip()[-2000:]
                raise RuntimeManagerError(f"Could not install verified aTalk {version}: {detail}")
            _verify_installed_distributions(release.site_packages, resolved)
            shutil.rmtree(wheelhouse)
            tree_digest = _release_tree_digest(temporary)
            _atomic_private_json(temporary / "release.json", {
                "version": 1,
                "stack": self.stack,
                "release": version,
                "packages": pins,
                "registry": PYPI_INDEX,
                "artifacts": artifacts,
                "resolved": resolved,
                "treeSha256": tree_digest,
            })
            self.verify(release)
            _replace_directory(temporary, final)
            release = self._release_from_path(version, final)
            self.verify(release)
            return release
        finally:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)

    def package_pins(self, version: str) -> list[str]:
        _validate_version(version)
        return [f"{package}=={version}" for package in PACKAGE_STACKS[self.stack]]

    def _verify_downloaded_wheels(self, wheelhouse: Path) -> dict[str, str]:
        wheels = sorted(wheelhouse.iterdir())
        if not wheels:
            raise RuntimeManagerError("PyPI returned no wheel artifacts")
        verified: dict[str, str] = {}
        for wheel in wheels:
            if not wheel.is_file() or wheel.suffix != ".whl":
                raise RuntimeManagerError(f"PyPI resolution included a non-wheel artifact: {wheel.name}")
            package, version = _wheel_distribution_and_version(wheel.name)
            metadata_package, metadata_version = _wheel_metadata_identity(wheel)
            if (
                _normalize_distribution(metadata_package) != _normalize_distribution(package)
                or metadata_version != version
            ):
                raise RuntimeManagerError(f"Wheel filename and internal package identity disagree: {wheel.name}")
            expected = self._artifact_hash_fetcher(package, version).get(wheel.name)
            digest = _sha256_file(wheel)
            if not expected or not _constant_time_digest(expected, digest):
                raise RuntimeManagerError(f"PyPI SHA-256 verification failed for {wheel.name}")
            verified[wheel.name] = digest
        downloaded_names = {_normalize_distribution(_wheel_distribution_and_version(path.name)[0]) for path in wheels}
        missing = {
            _normalize_distribution(package) for package in PACKAGE_STACKS[self.stack]
        } - downloaded_names
        if missing:
            raise RuntimeManagerError(f"PyPI resolution omitted required packages: {sorted(missing)}")
        return verified

    def verify(self, release: ManagedRelease) -> None:
        _validate_version(release.version)
        try:
            metadata = release.path.lstat()
        except FileNotFoundError as error:
            raise RuntimeManagerError("Staged environment is missing") from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
        ):
            raise RuntimeManagerError("Staged environment must be a private owner-only directory")
        try:
            manifest = _read_private_json(release.path / "release.json", MAX_RELEASE_MANIFEST_BYTES)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeManagerError("Staged environment has no trusted release manifest") from error
        expected_pins = self.package_pins(release.version)
        artifacts = manifest.get("artifacts")
        resolved = manifest.get("resolved")
        tree_digest = manifest.get("treeSha256")
        if (
            manifest.get("version") != 1
            or manifest.get("stack") != self.stack
            or manifest.get("release") != release.version
            or manifest.get("packages") != expected_pins
            or manifest.get("registry") != PYPI_INDEX
            or not isinstance(artifacts, dict)
            or not artifacts
            or any(
                not isinstance(name, str)
                or not isinstance(digest, str)
                or not _constant_time_digest(digest, digest)
                for name, digest in artifacts.items()
            )
            or not isinstance(resolved, dict)
            or any(not isinstance(name, str) or not isinstance(version, str) for name, version in resolved.items())
            or not isinstance(tree_digest, str)
            or not re.fullmatch(r"[0-9a-f]{64}", tree_digest)
        ):
            raise RuntimeManagerError("Staged environment release manifest is invalid")
        if _resolved_wheel_graph(artifacts) != resolved:
            raise RuntimeManagerError("Staged environment resolved graph does not match its verified artifacts")
        for package in PACKAGE_STACKS[self.stack]:
            if resolved.get(_normalize_distribution(package)) != release.version:
                raise RuntimeManagerError("Staged environment omitted an exact allowlisted package")
        _verify_installed_distributions(release.site_packages, resolved)
        actual_tree_digest = _release_tree_digest(release.path)
        if not hmac.compare_digest(tree_digest, actual_tree_digest):
            raise RuntimeManagerError("Staged environment content no longer matches its trusted manifest")

    def launch(self, release: ManagedRelease) -> ManagedProcess:
        # Revalidate from the manager process immediately before every launch.
        # Candidate code is never executed to attest its own identity or bytes.
        self.verify(release)
        self._validate_paired_credentials()
        peer_id = self._credential_peer_id()
        launch_id = str(uuid.uuid4())
        launched_at = self._clock()
        environment = os.environ.copy()
        environment.pop("ATALK_AGENT_TOKEN", None)
        environment.pop("ATALK_ACTIVATION_TOKEN", None)
        environment.update({
            "ATALK_CREDENTIAL_PATH": str(self.paths.credential),
            "ATALK_RUNTIME_MANAGER": "1",
            "ATALK_RUNTIME_LAUNCH_ID": launch_id,
            "ATALK_UPDATE_STATUS_PATH": str(self.paths.update_status),
            "ATALK_MANAGED_RELEASE": release.version,
            "PYTHONNOUSERSITE": "1",
            "VIRTUAL_ENV": str(release.path),
        })
        environment["PYTHONPATH"] = str(release.site_packages)
        environment["PATH"] = os.pathsep.join([
            str(_venv_bin(release.path)), environment.get("PATH", ""),
        ])
        if self._process_factory is not None:
            process: ManagedProcess = self._process_factory(
                list(self.command),
                cwd=self.working_directory,
                env=environment,
                start_new_session=True,
            )
        else:
            process = _launch_with_parent_watchdog(
                self.command,
                cwd=self.working_directory,
                environment=environment,
                shutdown_timeout_seconds=self.shutdown_timeout_seconds,
                lock_descriptor=self._lock_descriptor,
            )
        self._process_launch_ids[process.pid] = launch_id
        self._process_versions[process.pid] = release.version
        self._process_peer_ids[process.pid] = peer_id
        self._process_started_at[process.pid] = launched_at
        return process

    def health_check(self, process: ManagedProcess) -> bool:
        started = time.monotonic()
        deadline = started + self.health_timeout_seconds
        ready_observations = 0
        while not self._stopping and time.monotonic() < deadline:
            elapsed = time.monotonic() - started
            if self.health_snapshot(
                process,
                request_timeout=min(2.0, max(0.2, deadline - time.monotonic())),
            ):
                ready_observations += 1
                if ready_observations >= MIN_HEALTH_OBSERVATIONS and elapsed >= self.health_grace_seconds:
                    return True
            else:
                ready_observations = 0
                if process.poll() is not None:
                    return False
            time.sleep(0.2)
        return False

    def health_snapshot(self, process: ManagedProcess, *, request_timeout: float = 2.0) -> bool:
        if process.poll() is not None:
            return False
        version = self._process_versions.get(process.pid)
        if not version:
            return False
        status = self.read_update_status()
        if not status or not self._status_is_from_current_launch(status, process, version):
            return False
        if not self.health_url:
            return True
        try:
            request = Request(self.health_url, method="GET", headers={"user-agent": "atalk-runtime-manager/1"})
            with urlopen(request, timeout=request_timeout) as response:
                return _health_response_is_ready(
                    response,
                    expected_process_id=process.pid,
                    expected_version=version,
                    expected_peer_id=self._process_peer_ids.get(process.pid),
                    stack=self.stack,
                )
        except (OSError, ValueError):
            return False

    def stop_process(self, process: ManagedProcess) -> None:
        if isinstance(process, _WatchedProcess):
            if process.poll() is not None:
                process.close_keepalive()
                self._forget_process(process.pid)
                return
            # Only the watchdog owns this freshly created process group. Closing
            # the pipe requests bounded TERM/KILL/reap cleanup without reopening
            # a PID/PGID reuse race in the manager.
            process.close_keepalive()
            try:
                process.wait(
                    timeout=self.shutdown_timeout_seconds + WATCHDOG_CLEANUP_SLACK_SECONDS,
                )
            except subprocess.TimeoutExpired as error:
                if process.poll() is None:
                    raise RuntimeManagerError(
                        "Runtime watchdog did not finish process-group cleanup; "
                        "it remains responsible for the child and profile lock"
                    ) from error
            finally:
                if process.poll() is not None:
                    self._forget_process(process.pid)
            return
        if process.poll() is not None:
            self._forget_process(process.pid)
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=self.shutdown_timeout_seconds)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=2)
        finally:
            self._forget_process(process.pid)

    def _forget_process(self, process_id: int) -> None:
        self._process_launch_ids.pop(process_id, None)
        self._process_versions.pop(process_id, None)
        self._process_peer_ids.pop(process_id, None)
        self._process_started_at.pop(process_id, None)

    def _restart_until_healthy(self, release: ManagedRelease, *, reason: str) -> ManagedProcess | None:
        attempt = 0
        while not self._stopping:
            process: ManagedProcess | None = None
            try:
                process = self.launch(release)
                if self.health_check(process):
                    self._write_state(
                        "RUNNING", release, process.pid,
                        detail=(f"recovered_after={attempt}; reason={reason}" if attempt else None),
                    )
                    return process
            except Exception:
                if process is not None:
                    self.stop_process(process)
            else:
                if process is not None:
                    self.stop_process(process)
            delay = RUNTIME_RESTART_BACKOFF_SECONDS[
                min(attempt, len(RUNTIME_RESTART_BACKOFF_SECONDS) - 1)
            ]
            attempt += 1
            self._write_state(
                "RESTARTING", release, None,
                detail=f"reason={reason}; attempt={attempt}; retry_seconds={delay}",
            )
            self._interruptible_sleep(delay)
        return None

    def _interruptible_sleep(self, seconds: float) -> None:
        deadline = time.monotonic() + seconds
        while not self._stopping:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            time.sleep(min(0.5, remaining))

    def reconcile(
        self, process: ManagedProcess, current: ManagedRelease, target_version: str,
    ) -> ReconcileResult:
        # Staging and exact-version verification happen while the current runtime stays online.
        try:
            candidate = self.stage(target_version)
        except Exception as stage_error:
            self._record_update_failure(
                target_version, "STAGING", "registry_or_staging_failed",
            )
            if isinstance(stage_error, RuntimeManagerError):
                raise
            raise RuntimeManagerError(f"Could not stage candidate {target_version}") from stage_error
        if candidate.version == current.version:
            self._clear_update_failure(candidate.version)
            return ReconcileResult(process, current, updated=False, rolled_back=False)
        self._write_state(
            "SWITCHING", current, process.pid,
            detail=f"target={candidate.version}", target_release=candidate.version,
        )
        self.stop_process(process)
        candidate_process: ManagedProcess | None = None
        try:
            candidate_process = self.launch(candidate)
            if not self.health_check(candidate_process):
                raise RuntimeManagerError(f"Candidate {candidate.version} failed health checks")
            # The durable pointer is the commit record. Until candidate health
            # succeeds, a crash must leave startup selecting the previous release.
            self._write_pointer(candidate)
            self._clear_update_failure(candidate.version)
            self._write_state("RUNNING", candidate, candidate_process.pid, detail=f"updated_from={current.version}")
            return ReconcileResult(candidate_process, candidate, updated=True, rolled_back=False)
        except Exception as update_error:
            if candidate_process:
                self.stop_process(candidate_process)
            # Rollback is operational, not cosmetic: restore the pointer and restart
            # the last-known-good process before returning control to the monitor.
            self._write_pointer(current)
            failure = self._record_update_failure(
                candidate.version,
                "CANDIDATE",
                "candidate_health_or_switch_failed",
            )
            rollback_process: ManagedProcess | None = None
            try:
                rollback_process = self.launch(current)
                rollback_healthy = self.health_check(rollback_process)
            except Exception as rollback_error:
                self._write_state(
                    "ROLLBACK_DEGRADED", current, None,
                    detail=(f"candidate={candidate.version}; error={type(update_error).__name__}; "
                            f"rollback={type(rollback_error).__name__}"),
                    update_failure=failure,
                )
                raise RuntimeManagerError(
                    f"Update failed and previous runtime {current.version} could not be relaunched"
                ) from rollback_error
            self._write_state(
                "ROLLED_BACK" if rollback_healthy else "ROLLBACK_DEGRADED",
                current,
                rollback_process.pid if rollback_process.poll() is None else None,
                detail=f"candidate={candidate.version}; error={type(update_error).__name__}",
                update_failure=failure,
            )
            if not rollback_healthy:
                self.stop_process(rollback_process)
                raise RuntimeManagerError(
                    f"Update failed and previous runtime {current.version} remained unhealthy"
                ) from update_error
            if rollback_process.poll() is not None:
                raise RuntimeManagerError(
                    f"Update failed and previous runtime {current.version} could not be restarted"
                ) from update_error
            return ReconcileResult(rollback_process, current, updated=False, rolled_back=True)

    def update_deferment(self, version: str, *, include_expired: bool = False) -> UpdateFailure | None:
        try:
            _validate_version(version)
        except ValueError:
            return None
        failure = self._load_update_failures().get(version)
        if not failure:
            return None
        if include_expired or self._clock() < _parse_utc_timestamp(failure.next_retry_at):
            return failure
        return None

    def _record_update_failure(
        self,
        target_version: str,
        category: Literal["STAGING", "CANDIDATE"],
        reason: str,
    ) -> UpdateFailure:
        _validate_version(target_version)
        failures = self._load_update_failures()
        previous = failures.get(target_version)
        count = (previous.failures if previous and previous.category == category else 0) + 1
        schedule = STAGING_BACKOFF_SECONDS if category == "STAGING" else CANDIDATE_BACKOFF_SECONDS
        delay = schedule[min(count - 1, len(schedule) - 1)]
        now = self._clock()
        failure = UpdateFailure(
            target_version=target_version,
            category=category,
            reason=reason,
            failures=count,
            failed_at=_utc_timestamp_at(now),
            next_retry_at=_utc_timestamp_at(now + delay),
            quarantined=category == "CANDIDATE",
        )
        failures[target_version] = failure
        retained = sorted(
            failures.values(), key=lambda item: _parse_utc_timestamp(item.failed_at), reverse=True,
        )[:MAX_TRACKED_UPDATE_FAILURES]
        _atomic_private_json(self.paths.attempts, {
            "version": 1,
            "candidates": {item.target_version: item.to_wire() for item in retained},
        })
        return failure

    def _clear_update_failure(self, target_version: str) -> None:
        failures = self._load_update_failures()
        if failures.pop(target_version, None) is None:
            return
        _atomic_private_json(self.paths.attempts, {
            "version": 1,
            "candidates": {version: failure.to_wire() for version, failure in failures.items()},
        })

    def _load_update_failures(self) -> dict[str, UpdateFailure]:
        try:
            value = _read_private_json(self.paths.attempts, MAX_STATUS_BYTES)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            return {}
        if value.get("version") != 1 or not isinstance(value.get("candidates"), dict):
            return {}
        failures: dict[str, UpdateFailure] = {}
        for version, candidate in value["candidates"].items():
            parsed = _parse_update_failure(version, candidate)
            if parsed:
                failures[version] = parsed
        return failures

    def read_update_status(self) -> UpdateStatus | None:
        try:
            value = _read_private_json(self.paths.update_status, MAX_STATUS_BYTES)
        except FileNotFoundError:
            return None
        except (OSError, ValueError, json.JSONDecodeError):
            return None
        if value.get("version") != 1 or not isinstance(value.get("metadata"), dict):
            return None
        metadata = value["metadata"]
        sdk = metadata.get("sdk")
        integration = metadata.get("integration")
        capabilities = metadata.get("capabilities")
        if (
            not isinstance(sdk, dict)
            or sdk.get("name") != "atalk-sdk"
            or not isinstance(integration, dict)
            or integration.get("name") not in INTEGRATION_NAMES[self.stack]
            or not isinstance(capabilities, list)
            or any(not isinstance(item, str) for item in capabilities)
        ):
            return None
        advisory = parse_runtime_update_advisory(value.get("advisory"))
        writer_process_id = value.get("writerProcessId")
        writer_launch_id = value.get("writerLaunchId")
        writer_peer_id = value.get("writerPeerId")
        if not isinstance(writer_process_id, int) or isinstance(writer_process_id, bool) or writer_process_id <= 0:
            writer_process_id = None
        if not isinstance(writer_launch_id, str) or not _is_uuid(writer_launch_id):
            writer_launch_id = None
        if (
            not isinstance(writer_peer_id, str)
            or not 1 <= len(writer_peer_id) <= 200
            or any(character.isspace() for character in writer_peer_id)
        ):
            writer_peer_id = None
        return UpdateStatus(
            metadata=metadata,
            advisory=advisory,
            writer_process_id=writer_process_id,
            writer_launch_id=writer_launch_id,
            writer_peer_id=writer_peer_id,
        ) if advisory else None

    def _status_is_actionable(
        self,
        status: UpdateStatus,
        process: ManagedProcess,
        current_version: str,
    ) -> bool:
        return (
            status.advisory.current_version == current_version
            and self._status_is_from_current_launch(status, process, current_version)
        )

    def _status_is_from_current_launch(
        self,
        status: UpdateStatus,
        process: ManagedProcess,
        current_version: str,
    ) -> bool:
        launch_id = self._process_launch_ids.get(process.pid)
        expected_peer_id = self._process_peer_ids.get(process.pid)
        launched_at = self._process_started_at.get(process.pid)
        sdk = status.metadata.get("sdk")
        integration = status.metadata.get("integration")
        if (
            process.poll() is not None
            or status.writer_process_id != process.pid
            or not launch_id
            or status.writer_launch_id != launch_id
            or not expected_peer_id
            or status.writer_peer_id != expected_peer_id
            or launched_at is None
            or not isinstance(sdk, dict)
            or sdk.get("version") != current_version
            or not isinstance(integration, dict)
            or (self.stack == "hermes" and integration.get("version") != current_version)
        ):
            return False
        try:
            checked_at = _parse_utc_timestamp(status.advisory.checked_at)
        except ValueError:
            return False
        now = self._clock()
        return (
            checked_at >= now - MAX_ADVISORY_AGE_SECONDS
            and checked_at <= now + MAX_ADVISORY_FUTURE_SKEW_SECONDS
            and checked_at >= launched_at - MAX_ADVISORY_FUTURE_SKEW_SECONDS
        )

    def should_auto_update(self, status: UpdateStatus, current_version: str) -> bool:
        advisory = status.advisory
        target = advisory.recommended_version
        capabilities = status.metadata.get("capabilities", [])
        if (
            "runtime.auto-update" not in capabilities
            or advisory.status not in {"UPDATE_AVAILABLE", "UPDATE_REQUIRED"}
            or not target
            or not _is_newer_version(target, current_version)
            or not _is_compatible_line(target, current_version)
        ):
            return False
        rank = {"NOTIFY": 0, "SECURITY": 1, "COMPATIBLE": 2}
        effective_policy = min((self.update_ceiling, advisory.policy), key=rank.__getitem__)
        if effective_policy == "COMPATIBLE":
            return True
        return effective_policy == "SECURITY" and advisory.severity == "SECURITY"

    def _prepare_private_directories(self) -> None:
        self.paths.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.paths.releases.mkdir(mode=0o700, parents=True, exist_ok=True)
        _require_private_directory(self.paths.root)
        _require_private_directory(self.paths.releases)

    def _validate_paired_credentials(self) -> None:
        try:
            metadata = self.paths.credential.lstat()
        except FileNotFoundError as error:
            raise RuntimeManagerError(
                "Pair this agent once before enabling the Runtime Manager; no credential file was found"
            ) from error
        if (
            stat.S_ISLNK(metadata.st_mode)
            or not stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != os.getuid()
            or metadata.st_mode & 0o077
            or not 1 <= metadata.st_size <= 1024 * 1024
        ):
            raise RuntimeManagerError("Agent credentials must be a private owner-only regular file")

    def _credential_peer_id(self) -> str:
        try:
            value = _read_private_json(self.paths.credential, 1024 * 1024)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeManagerError("Agent credentials could not be read safely") from error
        peer = value.get("peer")
        peer_id = peer.get("id") if isinstance(peer, dict) else None
        if (
            not isinstance(peer_id, str)
            or not 1 <= len(peer_id) <= 200
            or any(character.isspace() for character in peer_id)
        ):
            raise RuntimeManagerError("Agent credentials do not contain a valid paired peer identity")
        return peer_id

    def _release_from_path(self, version: str, path: Path) -> ManagedRelease:
        if os.name == "nt":
            site_packages = path / "Lib" / "site-packages"
        else:
            site_packages = path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
        return ManagedRelease(version=version, path=path, site_packages=site_packages)

    def _load_current_release(self) -> ManagedRelease | None:
        version = self._load_pointer_version()
        if version is None:
            return None
        try:
            release = self._release_from_path(version, self.paths.releases / version)
            self.verify(release)
            return release
        except (ValueError, RuntimeManagerError):
            return None

    def _load_pointer_version(self) -> str | None:
        try:
            value = _read_private_json(self.paths.pointer, 4096)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            return None
        version = value.get("release")
        if value.get("version") != 1 or not isinstance(version, str):
            return None
        try:
            _validate_version(version)
            return version
        except ValueError:
            return None

    def _recover_stale_runtime(self) -> None:
        """Never signal a PID from stale state; fail closed if it may still be live."""
        try:
            value = _read_private_json(self.paths.state, MAX_STATUS_BYTES)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            return
        if value.get("status") == "SWITCHING":
            previous_version = value.get("release")
            target_version = value.get("targetRelease")
            if not isinstance(previous_version, str) or not isinstance(target_version, str):
                raise RuntimeManagerError("Incomplete runtime switch has an invalid transition journal")
            try:
                _validate_version(previous_version)
                _validate_version(target_version)
            except ValueError as error:
                raise RuntimeManagerError("Incomplete runtime switch has an invalid transition journal") from error
            # A target pointer can only be committed after the candidate passes
            # health. Otherwise restore and quarantine before launching anything.
            if self._load_pointer_version() != target_version:
                previous = self._release_from_path(
                    previous_version, self.paths.releases / previous_version,
                )
                self.verify(previous)
                failure = self._record_update_failure(
                    target_version, "CANDIDATE", "candidate_health_or_switch_failed",
                )
                self._write_pointer(previous)
                self._write_state(
                    "ROLLED_BACK", previous, None,
                    detail=f"candidate={target_version}; error=interrupted_switch",
                    update_failure=failure,
                )
                return
        process_id = value.get("pid")
        if (
            value.get("status") == "STOPPED"
            or not isinstance(process_id, int)
            or isinstance(process_id, bool)
            or process_id <= 0
            or not _pid_exists(process_id)
        ):
            return
        raise RuntimeManagerError(
            "A previously recorded runtime process may still be alive; refusing to signal a possibly reused PID. "
            "Stop that process explicitly, then start the Runtime Manager again"
        )

    def _rollback_monitored_candidate(
        self,
        process: ManagedProcess,
        candidate: ManagedRelease,
        previous: ManagedRelease,
    ) -> tuple[ManagedProcess, ManagedRelease]:
        self.stop_process(process)
        self._write_pointer(previous)
        failure = self._record_update_failure(
            candidate.version, "CANDIDATE", "candidate_health_or_switch_failed",
        )
        rollback_process = self.launch(previous)
        healthy = self.health_check(rollback_process)
        self._write_state(
            "ROLLED_BACK" if healthy else "ROLLBACK_DEGRADED",
            previous,
            rollback_process.pid if rollback_process.poll() is None else None,
            detail=f"candidate={candidate.version}; error=post_activation_health_lost",
            update_failure=failure,
        )
        if not healthy:
            self.stop_process(rollback_process)
            raise RuntimeManagerError(
                f"Candidate {candidate.version} lost health and previous runtime {previous.version} did not recover"
            )
        return rollback_process, previous

    def _write_pointer(self, release: ManagedRelease) -> None:
        _atomic_private_json(self.paths.pointer, {
            "version": 1,
            "release": release.version,
            "path": str(release.path),
        })

    def _write_state(
        self,
        status: str,
        release: ManagedRelease,
        pid: int | None,
        *,
        detail: str | None = None,
        update_failure: UpdateFailure | None = None,
        target_release: str | None = None,
    ) -> None:
        _atomic_private_json(self.paths.state, {
            "version": 1,
            "status": status,
            "release": release.version,
            "pid": pid,
            "updatedAt": _utc_timestamp_at(self._clock()),
            **({"detail": detail} if detail else {}),
            **({"update": update_failure.to_wire()} if update_failure else {}),
            **({"targetRelease": target_release} if target_release else {}),
        })


def _validate_version(version: str) -> None:
    if not _VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"Unsupported exact PEP 440 release: {version!r}")


def _absolute_path(value: str | Path) -> Path:
    return Path(os.path.abspath(Path(value).expanduser()))


def _is_uuid(value: str) -> bool:
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def _parse_update_failure(version: Any, value: Any) -> UpdateFailure | None:
    if not isinstance(version, str) or not isinstance(value, dict):
        return None
    try:
        _validate_version(version)
    except ValueError:
        return None
    category = value.get("category")
    reason = value.get("reason")
    failures = value.get("failures")
    failed_at = value.get("failedAt")
    next_retry_at = value.get("nextRetryAt")
    if (
        value.get("targetVersion") != version
        or category not in {"STAGING", "CANDIDATE"}
        or reason not in {"registry_or_staging_failed", "candidate_health_or_switch_failed"}
        or not isinstance(failures, int)
        or isinstance(failures, bool)
        or not 1 <= failures <= 1_000_000
        or not isinstance(failed_at, str)
        or not isinstance(next_retry_at, str)
        or value.get("quarantined") is not (category == "CANDIDATE")
    ):
        return None
    try:
        failed_epoch = _parse_utc_timestamp(failed_at)
        retry_epoch = _parse_utc_timestamp(next_retry_at)
    except ValueError:
        return None
    if retry_epoch <= failed_epoch:
        return None
    return UpdateFailure(
        target_version=version,
        category=category,
        reason=reason,
        failures=failures,
        failed_at=failed_at,
        next_retry_at=next_retry_at,
        quarantined=category == "CANDIDATE",
    )


def _version_key(version: str) -> tuple[tuple[int, ...], int, int]:
    match = _VERSION_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"Unsupported exact PEP 440 release: {version!r}")
    release = tuple(int(part) for part in match.group("release").split("."))
    rank = {"a": 0, "b": 1, "rc": 2, None: 3}[match.group("pre")]
    return release, rank, int(match.group("pre_n") or 0)


def _is_newer_version(candidate: str, current: str) -> bool:
    try:
        left = _version_key(candidate)
        right = _version_key(current)
    except ValueError:
        return False
    length = max(len(left[0]), len(right[0]))
    left_release = left[0] + (0,) * (length - len(left[0]))
    right_release = right[0] + (0,) * (length - len(right[0]))
    return (left_release, *left[1:]) > (right_release, *right[1:])


def _is_compatible_line(candidate: str, current: str) -> bool:
    try:
        candidate_release = _version_key(candidate)[0]
        current_release = _version_key(current)[0]
    except ValueError:
        return False
    candidate_major = candidate_release[0]
    current_major = current_release[0]
    if current_major != candidate_major:
        return False
    if current_major == 0:
        candidate_minor = candidate_release[1] if len(candidate_release) > 1 else 0
        current_minor = current_release[1] if len(current_release) > 1 else 0
        return candidate_minor == current_minor
    return True


def _wheel_distribution_and_version(filename: str) -> tuple[str, str]:
    if not filename.endswith(".whl"):
        raise RuntimeManagerError(f"Unsupported package artifact: {filename}")
    parts = filename[:-4].split("-")
    if len(parts) < 5 or not parts[0] or not parts[1]:
        raise RuntimeManagerError(f"Malformed wheel filename: {filename}")
    return parts[0].replace("_", "-"), parts[1]


def _wheel_metadata_identity(path: Path) -> tuple[str, str]:
    try:
        with zipfile.ZipFile(path) as archive:
            names = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
            if len(names) != 1:
                raise RuntimeManagerError(f"Wheel has an ambiguous package identity: {path.name}")
            metadata_bytes = archive.read(names[0])
    except (OSError, KeyError, zipfile.BadZipFile) as error:
        raise RuntimeManagerError(f"Could not inspect wheel metadata: {path.name}") from error
    if len(metadata_bytes) > 1024 * 1024:
        raise RuntimeManagerError(f"Wheel metadata is unexpectedly large: {path.name}")
    metadata = BytesParser(policy=compat32).parsebytes(metadata_bytes, headersonly=True)
    name = metadata.get("Name")
    version = metadata.get("Version")
    if not isinstance(name, str) or not name.strip() or not isinstance(version, str) or not version.strip():
        raise RuntimeManagerError(f"Wheel metadata omitted package identity: {path.name}")
    return name.strip(), version.strip()


def _resolved_wheel_graph(artifacts: dict[str, str]) -> dict[str, str]:
    resolved: dict[str, str] = {}
    for filename in artifacts:
        package, version = _wheel_distribution_and_version(filename)
        normalized = _normalize_distribution(package)
        if normalized in resolved:
            raise RuntimeManagerError(f"PyPI resolution returned duplicate wheels for {normalized}")
        resolved[normalized] = version
    return dict(sorted(resolved.items()))


def _verify_installed_distributions(site_packages: Path, expected: dict[str, str]) -> None:
    if not site_packages.is_dir():
        raise RuntimeManagerError("Staged environment has no site-packages directory")
    installed: dict[str, str] = {}
    try:
        distributions = importlib.metadata.distributions(path=[str(site_packages)])
        for distribution in distributions:
            name = distribution.metadata.get("Name")
            version = distribution.version
            if not isinstance(name, str) or not name.strip() or not isinstance(version, str):
                raise RuntimeManagerError("Staged environment contains invalid distribution metadata")
            normalized = _normalize_distribution(name)
            if normalized in installed:
                raise RuntimeManagerError(f"Staged environment contains duplicate metadata for {normalized}")
            installed[normalized] = version
    except (OSError, ValueError) as error:
        raise RuntimeManagerError("Could not inspect staged distribution metadata") from error
    # A fresh venv may contain these bootstrap tools before the verified wheel
    # graph is installed. No other undeclared distribution is accepted.
    for bootstrap in ("pip", "setuptools"):
        if bootstrap not in expected:
            installed.pop(bootstrap, None)
    if installed != expected:
        raise RuntimeManagerError(
            f"Staged distribution graph does not match verified wheel artifacts: {installed!r}"
        )


def _release_tree_digest(root: Path) -> str:
    digest = hashlib.sha256()
    try:
        for directory, directory_names, file_names in os.walk(root, topdown=True, followlinks=False):
            base = Path(directory)
            directory_names[:] = sorted(name for name in directory_names if name != "__pycache__")
            for name in list(directory_names):
                path = base / name
                if path.is_symlink():
                    directory_names.remove(name)
                    _hash_release_entry(digest, root, path)
            for name in sorted(file_names):
                if name == "release.json" and base == root:
                    continue
                if name.endswith(".pyc"):
                    continue
                _hash_release_entry(digest, root, base / name)
    except OSError as error:
        raise RuntimeManagerError("Could not hash staged environment content") from error
    return digest.hexdigest()


def _hash_release_entry(digest: Any, root: Path, path: Path) -> None:
    relative = path.relative_to(root).as_posix().encode("utf-8")
    metadata = path.lstat()
    digest.update(len(relative).to_bytes(8, "big"))
    digest.update(relative)
    digest.update(stat.S_IMODE(metadata.st_mode).to_bytes(4, "big"))
    if stat.S_ISLNK(metadata.st_mode):
        target = os.readlink(path).encode("utf-8")
        digest.update(b"L")
        digest.update(len(target).to_bytes(8, "big"))
        digest.update(target)
        return
    if not stat.S_ISREG(metadata.st_mode):
        raise RuntimeManagerError(f"Staged environment contains a special file: {path}")
    digest.update(b"F")
    digest.update(metadata.st_size.to_bytes(8, "big"))
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)


def _replace_directory(source: Path, destination: Path) -> None:
    displaced = destination.with_name(f".replaced-{destination.name}-{uuid.uuid4().hex}")
    moved_existing = False
    try:
        try:
            os.replace(destination, displaced)
            moved_existing = True
        except FileNotFoundError:
            pass
        os.replace(source, destination)
        _fsync_directory(destination.parent)
    except BaseException:
        if moved_existing and not destination.exists():
            with contextlib.suppress(OSError):
                os.replace(displaced, destination)
        raise
    finally:
        if displaced.exists() or displaced.is_symlink():
            _remove_path(displaced)


def _remove_path(path: Path) -> None:
    metadata = path.lstat()
    if stat.S_ISDIR(metadata.st_mode) and not stat.S_ISLNK(metadata.st_mode):
        shutil.rmtree(path)
    else:
        path.unlink()


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _normalize_distribution(value: str) -> str:
    return re.sub(r"[-_.]+", "-", value).lower()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _constant_time_digest(expected: str, actual: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-fA-F]{64}", expected)) and hmac.compare_digest(expected.lower(), actual.lower())


def _pypi_release_hashes(package: str, version: str) -> dict[str, str]:
    url = f"https://pypi.org/pypi/{quote(package, safe='')}/{quote(version, safe='')}/json"
    request = Request(url, method="GET", headers={"accept": "application/json", "user-agent": "atalk-runtime-manager/1"})
    try:
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                raise RuntimeManagerError(f"PyPI metadata request failed for {package}=={version}")
            payload = response.read(4 * 1024 * 1024 + 1)
    except OSError as error:
        raise RuntimeManagerError(f"Could not verify PyPI metadata for {package}=={version}") from error
    if len(payload) > 4 * 1024 * 1024:
        raise RuntimeManagerError(f"PyPI metadata is unexpectedly large for {package}=={version}")
    try:
        value = json.loads(payload)
    except json.JSONDecodeError as error:
        raise RuntimeManagerError(f"PyPI returned invalid metadata for {package}=={version}") from error
    if not isinstance(value, dict) or not isinstance(value.get("urls"), list):
        raise RuntimeManagerError(f"PyPI metadata omitted release files for {package}=={version}")
    hashes: dict[str, str] = {}
    official_package = _normalize_distribution(package) in {
        _normalize_distribution(name) for packages in PACKAGE_STACKS.values() for name in packages
    }
    for artifact in value["urls"]:
        if (
            isinstance(artifact, dict)
            and artifact.get("packagetype") == "bdist_wheel"
            and artifact.get("yanked") is not True
            and isinstance(artifact.get("filename"), str)
            and isinstance(artifact.get("digests"), dict)
            and isinstance(artifact["digests"].get("sha256"), str)
        ):
            filename = artifact["filename"]
            digest = artifact["digests"]["sha256"]
            if official_package and not _pypi_trusted_publisher_attests(package, version, filename, digest):
                continue
            hashes[filename] = digest
    if not hashes:
        suffix = " with the official aTalk Trusted Publisher provenance" if official_package else ""
        raise RuntimeManagerError(f"PyPI has no trusted wheels{suffix} for {package}=={version}")
    return hashes


def _pypi_trusted_publisher_attests(package: str, version: str, filename: str, digest: str) -> bool:
    url = (
        "https://pypi.org/integrity/"
        f"{quote(package, safe='')}/{quote(version, safe='')}/{quote(filename, safe='')}/provenance"
    )
    request = Request(
        url,
        method="GET",
        headers={
            "accept": "application/vnd.pypi.integrity.v1+json",
            "user-agent": "atalk-runtime-manager/1",
        },
    )
    try:
        with urlopen(request, timeout=10) as response:
            if response.status != 200:
                return False
            payload = response.read(4 * 1024 * 1024 + 1)
    except OSError:
        return False
    if len(payload) > 4 * 1024 * 1024:
        return False
    try:
        provenance = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return _trusted_publisher_provenance_matches(provenance, filename, digest)


def _trusted_publisher_provenance_matches(value: Any, filename: str, digest: str) -> bool:
    if (
        not isinstance(value, dict)
        or value.get("version") != 1
        or not isinstance(value.get("attestation_bundles"), list)
        or not re.fullmatch(r"[0-9a-fA-F]{64}", digest)
    ):
        return False
    for bundle in value["attestation_bundles"]:
        if (
            not isinstance(bundle, dict)
            or bundle.get("publisher") != OFFICIAL_PUBLISHER
            or not isinstance(bundle.get("attestations"), list)
        ):
            continue
        for attestation in bundle["attestations"]:
            envelope = attestation.get("envelope") if isinstance(attestation, dict) else None
            encoded = envelope.get("statement") if isinstance(envelope, dict) else None
            if not isinstance(encoded, str) or len(encoded) > 1024 * 1024:
                continue
            try:
                statement = json.loads(base64.b64decode(encoded, validate=True))
            except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            if (
                not isinstance(statement, dict)
                or statement.get("_type") != "https://in-toto.io/Statement/v1"
                or statement.get("predicateType") != PYPI_PUBLISH_ATTESTATION
                or not isinstance(statement.get("subject"), list)
            ):
                continue
            for subject in statement["subject"]:
                subject_digest = subject.get("digest") if isinstance(subject, dict) else None
                if (
                    isinstance(subject, dict)
                    and subject.get("name") == filename
                    and isinstance(subject_digest, dict)
                    and isinstance(subject_digest.get("sha256"), str)
                    and hmac.compare_digest(subject_digest["sha256"].lower(), digest.lower())
                ):
                    return True
    return False


def _health_response_is_ready(
    response: Any,
    *,
    expected_process_id: int,
    expected_version: str,
    expected_peer_id: str | None,
    stack: Literal["python", "hermes"],
) -> bool:
    if not 200 <= int(response.status) < 300:
        return False
    try:
        payload = response.read(64 * 1024 + 1)
    except (AttributeError, OSError):
        return False
    if not payload:
        return False
    if len(payload) > 64 * 1024:
        return False
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    if not isinstance(value, dict):
        return False
    identity = value.get("identity")
    runtime = value.get("runtime")
    metadata = runtime.get("metadata") if isinstance(runtime, dict) else None
    sdk = metadata.get("sdk") if isinstance(metadata, dict) else None
    integration = metadata.get("integration") if isinstance(metadata, dict) else None
    return (
        value.get("status") == "ok"
        and value.get("connected") is True
        and isinstance(identity, dict)
        and identity.get("id") == expected_peer_id
        and isinstance(runtime, dict)
        and runtime.get("processId") == expected_process_id
        and isinstance(sdk, dict)
        and sdk.get("name") == "atalk-sdk"
        and sdk.get("version") == expected_version
        and isinstance(integration, dict)
        and integration.get("name") in INTEGRATION_NAMES[stack]
        and (stack == "python" or integration.get("version") == expected_version)
    )


def _validate_health_url(value: str | None) -> str | None:
    if value is None:
        return None
    from urllib.parse import urlparse
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("Health URL must be an HTTP(S) URL without embedded credentials")
    return value


def _venv_bin(path: Path) -> Path:
    return path / ("Scripts" if os.name == "nt" else "bin")


def _venv_python(path: Path) -> Path:
    return _venv_bin(path) / ("python.exe" if os.name == "nt" else "python")


def _sanitized_install_environment() -> dict[str, str]:
    allowed = {
        "ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "LANG", "LC_ALL", "NO_PROXY", "PATH",
        "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "SYSTEMROOT", "TEMP", "TMP", "TMPDIR",
    }
    environment = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    environment["PIP_CONFIG_FILE"] = os.devnull
    environment["PIP_INDEX_URL"] = PYPI_INDEX
    environment.pop("PIP_EXTRA_INDEX_URL", None)
    environment.pop("PYTHONHOME", None)
    environment.pop("PYTHONPATH", None)
    return environment


_WATCHDOG_BOOTSTRAP = (
    "from atalk.runtime_manager import _watchdog_entry;"
    "import sys;"
    "raise SystemExit(_watchdog_entry(int(sys.argv[1]),int(sys.argv[2]),int(sys.argv[3])))"
)


def _launch_with_parent_watchdog(
    command: Sequence[str],
    *,
    cwd: Path | None,
    environment: dict[str, str],
    shutdown_timeout_seconds: float,
    lock_descriptor: int | None,
) -> _WatchedProcess:
    if os.name != "posix":
        raise RuntimeManagerError("The parent-death watchdog requires a POSIX platform")
    keepalive_read, keepalive_write = os.pipe()
    config_read, config_write = os.pipe()
    ready_read, ready_write = os.pipe()
    passed = [keepalive_read, config_read, ready_write]
    if lock_descriptor is not None:
        passed.append(lock_descriptor)
    watchdog_environment = _sanitized_install_environment()
    watchdog_environment["PYTHONNOUSERSITE"] = "1"
    watchdog: subprocess.Popen[bytes] | None = None
    try:
        watchdog = subprocess.Popen(
            [
                sys.executable,
                "-I",
                "-c",
                _WATCHDOG_BOOTSTRAP,
                str(keepalive_read),
                str(config_read),
                str(ready_write),
            ],
            env=watchdog_environment,
            pass_fds=tuple(passed),
            start_new_session=False,
        )
        os.close(keepalive_read)
        keepalive_read = -1
        os.close(config_read)
        config_read = -1
        os.close(ready_write)
        ready_write = -1
        with os.fdopen(config_write, "w", encoding="utf-8") as handle:
            config_write = -1
            json.dump({
                "command": list(command),
                "cwd": str(cwd) if cwd else None,
                "environment": environment,
                "shutdownTimeoutSeconds": shutdown_timeout_seconds,
            }, handle)
        readable, _, _ = select.select([ready_read], [], [], 10.0)
        if not readable:
            raise RuntimeManagerError("Parent-death watchdog did not start the runtime in time")
        with os.fdopen(ready_read, "r", encoding="utf-8") as handle:
            ready_read = -1
            line = handle.readline(16 * 1024)
        try:
            result = json.loads(line)
        except json.JSONDecodeError as error:
            raise RuntimeManagerError("Parent-death watchdog returned invalid startup state") from error
        process_id = result.get("pid") if isinstance(result, dict) else None
        if not isinstance(process_id, int) or isinstance(process_id, bool) or process_id <= 0:
            detail = result.get("error") if isinstance(result, dict) else None
            raise RuntimeManagerError(
                f"Parent-death watchdog could not launch the runtime: {detail or 'unknown error'}"
            )
        return _WatchedProcess(process_id, watchdog, keepalive_write)
    except BaseException:
        with contextlib.suppress(OSError):
            os.close(keepalive_write)
        if watchdog is not None:
            with contextlib.suppress(ProcessLookupError):
                watchdog.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                watchdog.wait(timeout=2)
        raise
    finally:
        for descriptor in (keepalive_read, config_read, config_write, ready_read, ready_write):
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)


def _watchdog_entry(keepalive_descriptor: int, config_descriptor: int, ready_descriptor: int) -> int:
    """Internal subprocess entrypoint. EOF from the manager terminates the entire child group."""
    stop_requested = False

    def request_stop(_signum: int, _frame: Any) -> None:
        nonlocal stop_requested
        stop_requested = True

    # A terminal or service manager can signal the manager and watchdog
    # together. Keep the watchdog alive long enough to reap the child group;
    # caught handlers reset to defaults when the actual child execs.
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(signum, request_stop)
    child: subprocess.Popen[bytes] | None = None
    exit_observer: _ProcessExitObserver | None = None
    try:
        with os.fdopen(config_descriptor, "r", encoding="utf-8") as handle:
            config = json.load(handle)
        command = config.get("command") if isinstance(config, dict) else None
        environment = config.get("environment") if isinstance(config, dict) else None
        cwd = config.get("cwd") if isinstance(config, dict) else None
        shutdown_timeout = config.get("shutdownTimeoutSeconds") if isinstance(config, dict) else None
        if (
            not isinstance(command, list)
            or not command
            or any(not isinstance(item, str) or not item for item in command)
            or not isinstance(environment, dict)
            or any(not isinstance(key, str) or not isinstance(value, str) for key, value in environment.items())
            or (cwd is not None and not isinstance(cwd, str))
            or not isinstance(shutdown_timeout, (int, float))
            or isinstance(shutdown_timeout, bool)
            or shutdown_timeout <= 0
        ):
            raise ValueError("invalid watchdog configuration")
        if stop_requested:
            raise RuntimeManagerError("watchdog stop requested during startup")
        child = subprocess.Popen(
            command,
            cwd=cwd,
            env=environment,
            start_new_session=True,
            close_fds=True,
        )
        exit_observer = _ProcessExitObserver(child.pid)
        _write_watchdog_ready(ready_descriptor, {"pid": child.pid})
        ready_descriptor = -1
        while True:
            # Observe without reaping: the unreaped session leader keeps this
            # manager-owned PGID from being reused while descendants are killed.
            if exit_observer.exited():
                _terminate_process_group(child, float(shutdown_timeout))
                break
            if stop_requested:
                _terminate_process_group(child, float(shutdown_timeout))
                break
            readable, _, _ = select.select([keepalive_descriptor], [], [], 0.2)
            if not readable:
                continue
            if os.read(keepalive_descriptor, 1):
                continue
            _terminate_process_group(child, float(shutdown_timeout))
            break
        return _portable_return_code(child.returncode if child.returncode is not None else child.wait())
    except BaseException as error:
        if ready_descriptor >= 0:
            with contextlib.suppress(OSError):
                _write_watchdog_ready(ready_descriptor, {"error": type(error).__name__})
        if child is not None:
            with contextlib.suppress(OSError, ChildProcessError):
                _terminate_process_group(child, 2.0)
        return 125
    finally:
        if exit_observer is not None:
            exit_observer.close()
        for descriptor in (keepalive_descriptor, ready_descriptor):
            if descriptor >= 0:
                with contextlib.suppress(OSError):
                    os.close(descriptor)


def _write_watchdog_ready(descriptor: int, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    os.write(descriptor, payload)
    os.close(descriptor)


class _ProcessExitObserver:
    """Observe a child exit without reaping its PID/PGID ownership token."""

    def __init__(self, process_id: int):
        self.process_id = process_id
        self._queue: Any | None = None
        self._already_exited = False
        if all(hasattr(os, name) for name in ("waitid", "P_PID", "WEXITED", "WNOHANG", "WNOWAIT")):
            return
        if not all(
            hasattr(select, name)
            for name in ("kqueue", "kevent", "KQ_FILTER_PROC", "KQ_NOTE_EXIT", "KQ_EV_ADD", "KQ_EV_ENABLE")
        ):
            raise RuntimeManagerError("This POSIX platform cannot safely observe managed process exit")
        self._queue = select.kqueue()
        event = select.kevent(
            process_id,
            filter=select.KQ_FILTER_PROC,
            flags=select.KQ_EV_ADD | select.KQ_EV_ENABLE,
            fflags=select.KQ_NOTE_EXIT,
        )
        try:
            self._queue.control([event], 0, 0)
        except ProcessLookupError:
            self._already_exited = True

    def exited(self) -> bool:
        if self._already_exited:
            return True
        if self._queue is not None:
            return bool(self._queue.control([], 1, 0))
        try:
            result = os.waitid(
                os.P_PID,
                self.process_id,
                os.WEXITED | os.WNOHANG | os.WNOWAIT,
            )
        except ChildProcessError:
            return True
        return result is not None

    def close(self) -> None:
        if self._queue is not None:
            self._queue.close()
            self._queue = None


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can report EPERM for a group containing only an unreaped leader.
        return True


def _terminate_process_group(process: subprocess.Popen[bytes], timeout: float) -> None:
    process_group_id = process.pid
    with contextlib.suppress(ProcessLookupError, PermissionError):
        os.killpg(process_group_id, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while _process_group_exists(process_group_id) and time.monotonic() < deadline:
        time.sleep(0.05)
    if _process_group_exists(process_group_id):
        # Signal before reaping the leader, which prevents this PGID from being
        # reassigned to an unrelated process group during cleanup.
        with contextlib.suppress(ProcessLookupError, PermissionError):
            os.killpg(process_group_id, signal.SIGKILL)
    process.wait()
    # Do not release the inherited profile lock while an owned descendant can
    # still be observed in the group. No further signals occur after reaping.
    while _process_group_exists(process_group_id):
        time.sleep(0.05)


def _portable_return_code(return_code: int) -> int:
    if return_code < 0:
        return 128 + min(127, -return_code)
    return min(255, return_code)


def _pid_exists(process_id: int) -> bool:
    try:
        os.kill(process_id, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _atomic_private_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
        _fsync_directory(path.parent)
    except BaseException:
        with contextlib.suppress(FileNotFoundError):
            temporary.unlink()
        raise


def _read_private_json(path: Path, maximum_bytes: int) -> dict[str, Any]:
    metadata = path.lstat()
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("Runtime manager state must be a regular file")
    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
        raise ValueError("Runtime manager state must be owner-only")
    if metadata.st_size > maximum_bytes:
        raise ValueError("Runtime manager state is too large")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    opened = os.fstat(descriptor)
    if (
        not stat.S_ISREG(opened.st_mode)
        or opened.st_uid != os.getuid()
        or opened.st_mode & 0o077
        or opened.st_size > maximum_bytes
    ):
        os.close(descriptor)
        raise ValueError("Runtime manager state changed while being opened")
    with os.fdopen(descriptor, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("Runtime manager state must contain a JSON object")
    return value


def _require_private_directory(path: Path) -> None:
    metadata = path.lstat()
    if (
        stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_mode & 0o077
    ):
        raise RuntimeManagerError(f"Runtime Manager directory must be private and owner-only: {path}")


@contextlib.contextmanager
def _exclusive_lock(path: Path) -> Iterator[int]:
    import fcntl
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        if error.errno in {errno.ELOOP, errno.EMLINK}:
            raise RuntimeManagerError("Runtime Manager lock must not be a symbolic link") from error
        raise
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
        os.close(descriptor)
        raise RuntimeManagerError("Runtime Manager lock must be an owner-controlled regular file")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise RuntimeManagerError("Another Runtime Manager already owns this profile") from error
    try:
        os.fchmod(descriptor, 0o600)
        yield descriptor
    finally:
        # Do not issue LOCK_UN: the watchdog inherits this open-file-description
        # and must keep the profile locked after the manager closes its copy.
        os.close(descriptor)


@contextlib.contextmanager
def _termination_handlers(manager: RuntimeManager) -> Iterator[None]:
    previous: dict[int, Any] = {}

    def stop(_signum: int, _frame: Any) -> None:
        manager._stopping = True

    for signum in (signal.SIGINT, signal.SIGTERM):
        previous[signum] = signal.getsignal(signum)
        signal.signal(signum, stop)
    try:
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _utc_timestamp_at(epoch_seconds: float) -> str:
    from datetime import datetime, timezone
    return datetime.fromtimestamp(epoch_seconds, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_utc_timestamp(value: str) -> float:
    from datetime import datetime
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timestamp must include a timezone")
    return parsed.timestamp()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="atalk-runtime-manager",
        description="Run an aTalk Python connector with safe, policy-controlled updates and rollback.",
    )
    subparsers = parser.add_subparsers(dest="action", required=True)
    run = subparsers.add_parser("run")
    run.add_argument("--stack", choices=sorted(PACKAGE_STACKS), required=True)
    run.add_argument("--profile", required=True)
    run.add_argument("--version", required=True, help="Exact installed bootstrap version, for example 0.1.0a11")
    run.add_argument("--credential-path", required=True)
    run.add_argument("--root", default="~/.atalk/runtime-manager")
    run.add_argument("--status-path")
    run.add_argument("--cwd")
    run.add_argument("--health-url")
    run.add_argument("--health-grace", type=float, default=8.0)
    run.add_argument("--health-timeout", type=float, default=30.0)
    run.add_argument("--poll-interval", type=float, default=15.0)
    run.add_argument("--shutdown-timeout", type=float, default=10.0)
    run.add_argument(
        "--update-ceiling", choices=["NOTIFY", "SECURITY", "COMPATIBLE"], default="COMPATIBLE",
        help=("Local maximum automation level. COMPATIBLE (default) lets the owner's app policy govern; "
              "SECURITY or NOTIFY can only restrict it."),
    )
    run.add_argument("command", nargs=argparse.REMAINDER, help="Local command after --; never supplied by aTalk")
    status = subparsers.add_parser("status")
    status.add_argument("--profile", required=True)
    status.add_argument("--root", default="~/.atalk/runtime-manager")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.action == "status":
        path = Path(arguments.root).expanduser().resolve() / arguments.profile / "manager-state.json"
        try:
            print(json.dumps(_read_private_json(path, MAX_STATUS_BYTES), indent=2, sort_keys=True))
            return 0
        except FileNotFoundError:
            print("No Runtime Manager state found.", file=sys.stderr)
            return 1
    command = list(arguments.command)
    if command and command[0] == "--":
        command = command[1:]
    manager = RuntimeManager(
        stack=arguments.stack,
        profile=arguments.profile,
        initial_version=arguments.version,
        credential_path=arguments.credential_path,
        command=command,
        root=arguments.root,
        update_status_path=arguments.status_path,
        working_directory=arguments.cwd,
        health_url=arguments.health_url,
        health_grace_seconds=arguments.health_grace,
        health_timeout_seconds=arguments.health_timeout,
        poll_interval_seconds=arguments.poll_interval,
        shutdown_timeout_seconds=arguments.shutdown_timeout,
        update_ceiling=arguments.update_ceiling,
    )
    return manager.run()


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "INTEGRATION_NAMES",
    "ManagedRelease",
    "PACKAGE_STACKS",
    "PYPI_INDEX",
    "ReconcileResult",
    "RuntimeManager",
    "RuntimeManagerError",
    "RuntimeManagerPaths",
    "UpdateStatus",
    "UpdateFailure",
    "main",
]
