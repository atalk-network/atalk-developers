"""Opt-in, external supervisor for safe aTalk Python connector updates.

The manager consumes the SDK's private advisory sidecar. It never evaluates a
server-supplied command: package names, registry, process command and health
probe all come from this local program/configuration.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
import venv
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterator, Literal, Sequence
from urllib.request import Request, urlopen
from urllib.parse import quote

from .runtime_update import RuntimeUpdateAdvisory, parse_runtime_update_advisory


PYPI_INDEX = "https://pypi.org/simple"
MAX_STATUS_BYTES = 64 * 1024
MAX_TRACKED_UPDATE_FAILURES = 32
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


@dataclass(frozen=True)
class ReconcileResult:
    process: subprocess.Popen[bytes]
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
        process_factory: ProcessFactory = subprocess.Popen,
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
            credential.relative_to(releases)
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

    def run(self) -> int:
        self._prepare_private_directories()
        self._validate_paired_credentials()
        with _exclusive_lock(self.paths.lock), _termination_handlers(self):
            release = self._load_current_release() or self.stage(self.initial_version)
            self._write_pointer(release)
            process = self.launch(release)
            if not self.health_check(process):
                self.stop_process(process)
                raise RuntimeManagerError(f"Initial runtime {release.version} did not pass its health check")
            self._write_state("RUNNING", release, process.pid)
            try:
                while not self._stopping:
                    if process.poll() is not None:
                        self._write_state("RESTARTING", release, None, detail=f"exit={process.returncode}")
                        time.sleep(min(2.0, self.poll_interval_seconds))
                        process = self.launch(release)
                        if not self.health_check(process):
                            self.stop_process(process)
                            raise RuntimeManagerError(f"Runtime {release.version} repeatedly failed health checks")
                        self._write_state("RUNNING", release, process.pid)
                    update = self.read_update_status()
                    if update and self.should_auto_update(update, release.version):
                        target_version = update.advisory.recommended_version or ""
                        deferred = self.update_deferment(target_version)
                        if deferred:
                            self._write_state(
                                "UPDATE_DEFERRED", release, process.pid, update_failure=deferred,
                            )
                            time.sleep(self.poll_interval_seconds)
                            continue
                        try:
                            result = self.reconcile(process, release, target_version)
                            process, release = result.process, result.release
                        except RuntimeManagerError as error:
                            # A registry/staging failure leaves the current process untouched.
                            # A failed rollback only reaches here if the prior process could not
                            # be relaunched, in which case the monitor exits explicitly.
                            if process.poll() is not None:
                                raise
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
        return 0

    def stage(self, version: str) -> ManagedRelease:
        _validate_version(version)
        final = self.paths.releases / version
        if final.exists():
            release = self._release_from_path(version, final)
            self.verify(release)
            return release
        temporary = self.paths.releases / f".stage-{version}-{uuid.uuid4().hex}"
        try:
            venv.EnvBuilder(with_pip=True, clear=False, symlinks=os.name != "nt").create(temporary)
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
            self.verify(release)
            _atomic_private_json(temporary / "release.json", {
                "version": 1,
                "stack": self.stack,
                "release": version,
                "packages": pins,
                "registry": PYPI_INDEX,
                "artifacts": artifacts,
            })
            shutil.rmtree(wheelhouse)
            try:
                os.replace(temporary, final)
            except OSError:
                if not final.exists():
                    raise
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
        script = (
            "import importlib.metadata,json,sys;"
            f"p={json.dumps(list(PACKAGE_STACKS[self.stack]))};"
            "print(json.dumps({n:importlib.metadata.version(n) for n in p},sort_keys=True))"
        )
        completed = self._command_runner(
            [str(_venv_python(release.path)), "-I", "-c", script],
            cwd=release.path,
            env=_sanitized_install_environment(),
            text=True,
            capture_output=True,
            check=False,
        )
        if completed.returncode != 0:
            raise RuntimeManagerError(f"Staged environment verification failed: {(completed.stderr or '').strip()[-1000:]}")
        try:
            installed = json.loads(completed.stdout)
        except (TypeError, json.JSONDecodeError) as error:
            raise RuntimeManagerError("Staged environment returned invalid package metadata") from error
        expected = {package: release.version for package in PACKAGE_STACKS[self.stack]}
        if installed != expected:
            raise RuntimeManagerError(f"Staged package versions do not match exact pins: {installed!r}")

    def launch(self, release: ManagedRelease) -> subprocess.Popen[bytes]:
        self._validate_paired_credentials()
        environment = os.environ.copy()
        environment.pop("ATALK_AGENT_TOKEN", None)
        environment.pop("ATALK_ACTIVATION_TOKEN", None)
        environment.update({
            "ATALK_CREDENTIAL_PATH": str(self.paths.credential),
            "ATALK_RUNTIME_MANAGER": "1",
            "ATALK_UPDATE_STATUS_PATH": str(self.paths.update_status),
            "ATALK_MANAGED_RELEASE": release.version,
            "PYTHONNOUSERSITE": "1",
            "VIRTUAL_ENV": str(release.path),
        })
        environment["PYTHONPATH"] = str(release.site_packages)
        environment["PATH"] = os.pathsep.join([
            str(_venv_bin(release.path)), environment.get("PATH", ""),
        ])
        return self._process_factory(
            list(self.command),
            cwd=self.working_directory,
            env=environment,
            start_new_session=os.name != "nt",
        )

    def health_check(self, process: subprocess.Popen[bytes]) -> bool:
        started = time.monotonic()
        deadline = started + self.health_timeout_seconds
        while time.monotonic() < deadline:
            if process.poll() is not None:
                return False
            elapsed = time.monotonic() - started
            if self.health_url:
                try:
                    request = Request(self.health_url, method="GET", headers={"user-agent": "atalk-runtime-manager/1"})
                    with urlopen(request, timeout=min(2.0, max(0.2, deadline - time.monotonic()))) as response:
                        # A single fast 2xx is not enough: a candidate may bind
                        # briefly and crash immediately afterwards. Reuse the
                        # configured startup grace as a minimum probation period.
                        if _health_response_is_ready(response) and elapsed >= self.health_grace_seconds:
                            return True
                except OSError:
                    pass
            elif elapsed >= self.health_grace_seconds:
                return True
            time.sleep(0.2)
        return False

    def stop_process(self, process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
            process.wait(timeout=self.shutdown_timeout_seconds)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            if process.poll() is None:
                try:
                    if os.name != "nt":
                        os.killpg(process.pid, signal.SIGKILL)
                    else:
                        process.kill()
                except ProcessLookupError:
                    pass
                with contextlib.suppress(subprocess.TimeoutExpired):
                    process.wait(timeout=2)

    def reconcile(
        self, process: subprocess.Popen[bytes], current: ManagedRelease, target_version: str,
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
        self._write_state("SWITCHING", current, process.pid, detail=f"target={candidate.version}")
        self.stop_process(process)
        candidate_process: subprocess.Popen[bytes] | None = None
        try:
            self._write_pointer(candidate)
            candidate_process = self.launch(candidate)
            if not self.health_check(candidate_process):
                raise RuntimeManagerError(f"Candidate {candidate.version} failed health checks")
            self._clear_update_failure(candidate.version)
            self._write_state("RUNNING", candidate, candidate_process.pid, detail=f"updated_from={current.version}")
            return ReconcileResult(candidate_process, candidate, updated=True, rolled_back=False)
        except Exception as update_error:
            if candidate_process:
                self.stop_process(candidate_process)
            # Rollback is operational, not cosmetic: restore the pointer and restart
            # the last-known-good process before returning control to the monitor.
            self._write_pointer(current)
            rollback_process = self.launch(current)
            rollback_healthy = self.health_check(rollback_process)
            failure = self._record_update_failure(
                candidate.version,
                "CANDIDATE",
                "candidate_health_or_switch_failed",
            )
            self._write_state(
                "ROLLED_BACK" if rollback_healthy else "ROLLBACK_DEGRADED",
                current,
                rollback_process.pid if rollback_process.poll() is None else None,
                detail=f"candidate={candidate.version}; error={type(update_error).__name__}",
                update_failure=failure,
            )
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
        return UpdateStatus(metadata=metadata, advisory=advisory) if advisory else None

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

    def _release_from_path(self, version: str, path: Path) -> ManagedRelease:
        if os.name == "nt":
            site_packages = path / "Lib" / "site-packages"
        else:
            site_packages = path / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
        return ManagedRelease(version=version, path=path, site_packages=site_packages)

    def _load_current_release(self) -> ManagedRelease | None:
        try:
            value = _read_private_json(self.paths.pointer, 4096)
        except (FileNotFoundError, OSError, ValueError, json.JSONDecodeError):
            return None
        version = value.get("release")
        if value.get("version") != 1 or not isinstance(version, str):
            return None
        try:
            _validate_version(version)
            release = self._release_from_path(version, self.paths.releases / version)
            self.verify(release)
            return release
        except (ValueError, RuntimeManagerError):
            return None

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
    ) -> None:
        _atomic_private_json(self.paths.state, {
            "version": 1,
            "status": status,
            "release": release.version,
            "pid": pid,
            "updatedAt": _utc_timestamp_at(self._clock()),
            **({"detail": detail} if detail else {}),
            **({"update": update_failure.to_wire()} if update_failure else {}),
        })


def _validate_version(version: str) -> None:
    if not _VERSION_PATTERN.fullmatch(version):
        raise ValueError(f"Unsupported exact PEP 440 release: {version!r}")


def _absolute_path(value: str | Path) -> Path:
    return Path(os.path.abspath(Path(value).expanduser()))


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
    for artifact in value["urls"]:
        if (
            isinstance(artifact, dict)
            and artifact.get("packagetype") == "bdist_wheel"
            and artifact.get("yanked") is not True
            and isinstance(artifact.get("filename"), str)
            and isinstance(artifact.get("digests"), dict)
            and isinstance(artifact["digests"].get("sha256"), str)
        ):
            hashes[artifact["filename"]] = artifact["digests"]["sha256"]
    if not hashes:
        raise RuntimeManagerError(f"PyPI has no trusted wheels for {package}=={version}")
    return hashes


def _health_response_is_ready(response: Any) -> bool:
    if not 200 <= int(response.status) < 300:
        return False
    try:
        payload = response.read(64 * 1024 + 1)
    except (AttributeError, OSError):
        return True
    if not payload:
        return True
    if len(payload) > 64 * 1024:
        return False
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return True
    if not isinstance(value, dict):
        return True
    if isinstance(value.get("connected"), bool) and value["connected"] is not True:
        return False
    if isinstance(value.get("ok"), bool) and value["ok"] is not True:
        return False
    if isinstance(value.get("status"), str) and value["status"].lower() in {"down", "failed", "unhealthy"}:
        return False
    return True


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
def _exclusive_lock(path: Path) -> Iterator[None]:
    import fcntl
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise RuntimeManagerError("Another Runtime Manager already owns this profile") from error
    try:
        os.fchmod(descriptor, 0o600)
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
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
