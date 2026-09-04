from __future__ import annotations

import json
import os
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse


ATALK_SDK_VERSION = "0.1.0a11"
ATALK_PROTOCOL_VERSION = 1

RuntimeReleaseChannel = Literal["STABLE", "PREVIEW"]
RuntimeUpdateStatus = Literal["CURRENT", "UPDATE_AVAILABLE", "UPDATE_REQUIRED", "UNKNOWN"]
RuntimeUpdateSeverity = Literal["INFO", "SECURITY", "INCOMPATIBLE"]
RuntimeUpdatePolicy = Literal["NOTIFY", "SECURITY", "COMPATIBLE"]


@dataclass(frozen=True)
class RuntimeComponent:
    name: str
    version: str


@dataclass(frozen=True)
class RuntimeOptions:
    """Administrative runtime metadata; it is never added to a model message."""

    integration: RuntimeComponent | None = None
    host: RuntimeComponent | None = None
    channel: RuntimeReleaseChannel = "PREVIEW"
    capabilities: tuple[str, ...] | list[str] | None = None
    update_status_path: str | Path | Literal[False] | None = None


@dataclass(frozen=True)
class RuntimeCheckIn:
    sdk: RuntimeComponent
    integration: RuntimeComponent
    protocol_version: Literal[1]
    channel: RuntimeReleaseChannel
    capabilities: tuple[str, ...]
    host: RuntimeComponent | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "sdk": asdict(self.sdk),
            "integration": asdict(self.integration),
            **({"host": asdict(self.host)} if self.host else {}),
            "protocolVersion": self.protocol_version,
            "channel": self.channel,
            "capabilities": list(self.capabilities),
        }


@dataclass(frozen=True)
class RuntimeUpdateAdvisory:
    status: RuntimeUpdateStatus
    current_version: str
    severity: RuntimeUpdateSeverity
    policy: RuntimeUpdatePolicy
    checked_at: str
    recommended_version: str | None = None
    minimum_version: str | None = None
    release_notes_url: str | None = None

    def to_wire(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "currentVersion": self.current_version,
            **({"recommendedVersion": self.recommended_version} if self.recommended_version else {}),
            **({"minimumVersion": self.minimum_version} if self.minimum_version else {}),
            "severity": self.severity,
            **({"releaseNotesUrl": self.release_notes_url} if self.release_notes_url else {}),
            "policy": self.policy,
            "checkedAt": self.checked_at,
        }


DEFAULT_RUNTIME_CAPABILITIES = (
    "attachments",
    "directed-mentions",
    "e2ee",
    "supervision",
    "text",
    "workrooms",
)


def resolve_runtime_check_in(options: RuntimeOptions | None = None) -> RuntimeCheckIn:
    integration = options.integration if options and options.integration else RuntimeComponent(
        name="custom", version=ATALK_SDK_VERSION,
    )
    capabilities = options.capabilities if options and options.capabilities is not None else DEFAULT_RUNTIME_CAPABILITIES
    return RuntimeCheckIn(
        sdk=_normalize_component(RuntimeComponent("atalk-sdk", ATALK_SDK_VERSION)),
        integration=_normalize_component(integration),
        **({"host": _normalize_component(options.host)} if options and options.host else {}),
        protocol_version=1,
        channel=options.channel if options else "PREVIEW",
        capabilities=tuple(sorted(set(_normalize_capability(value) for value in capabilities))),
    )


def parse_runtime_update_advisory(value: Any) -> RuntimeUpdateAdvisory | None:
    if not isinstance(value, dict):
        return None
    status = _enum(value.get("status"), {"CURRENT", "UPDATE_AVAILABLE", "UPDATE_REQUIRED", "UNKNOWN"})
    severity = _enum(value.get("severity"), {"INFO", "SECURITY", "INCOMPATIBLE"})
    policy = _enum(value.get("policy"), {"NOTIFY", "SECURITY", "COMPATIBLE"})
    checked_at = _bounded_string(value.get("checkedAt"), 1, 80)
    current_version = _bounded_string(value.get("currentVersion"), 1, 80)
    if (
        not status or not severity or not policy or not checked_at or not current_version
        or not _valid_iso_datetime(checked_at)
    ):
        return None
    optional_strings: dict[str, str | None] = {
        "current_version": current_version,
        "recommended_version": _optional_string(value, "recommendedVersion", 80),
        "minimum_version": _optional_string(value, "minimumVersion", 80),
    }
    for python_name, wire_name in (
        ("recommended_version", "recommendedVersion"),
        ("minimum_version", "minimumVersion"),
    ):
        if wire_name in value and optional_strings[python_name] is None:
            return None
    release_notes_url = _optional_string(value, "releaseNotesUrl", 2048)
    if "releaseNotesUrl" in value and (release_notes_url is None or not _http_url(release_notes_url)):
        return None
    return RuntimeUpdateAdvisory(
        status=status,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        policy=policy,  # type: ignore[arg-type]
        checked_at=checked_at,
        current_version=optional_strings["current_version"],
        recommended_version=optional_strings["recommended_version"],
        minimum_version=optional_strings["minimum_version"],
        release_notes_url=release_notes_url,
    )


def persist_runtime_update_status(
    path: str | Path, metadata: RuntimeCheckIn, advisory: RuntimeUpdateAdvisory,
) -> None:
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    value = {
        "version": 1,
        "metadata": metadata.to_wire(),
        "advisory": advisory.to_wire(),
    }
    _atomic_private_json(target, value)


def _atomic_private_json(path: Path, value: dict[str, Any]) -> None:
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
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _normalize_component(component: RuntimeComponent) -> RuntimeComponent:
    name = _bounded_string(component.name, 1, 120)
    version = _bounded_string(component.version, 1, 64)
    if not name or not version or any(char.isspace() for char in version):
        raise ValueError("Runtime component names and versions must be non-empty bounded strings")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@._/-")
    if any(char not in allowed for char in name):
        raise ValueError("Runtime component names contain unsupported characters")
    return RuntimeComponent(name=name, version=version)


def _normalize_capability(value: str) -> str:
    normalized = _bounded_string(value, 1, 120)
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._:/-")
    if not normalized or any(char not in allowed for char in normalized):
        raise ValueError("Runtime capabilities must be non-empty bounded identifiers")
    return normalized


def _enum(value: Any, allowed: set[str]) -> str | None:
    return value if isinstance(value, str) and value in allowed else None


def _bounded_string(value: Any, minimum: int, maximum: int) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip()
    return normalized if minimum <= len(normalized) <= maximum else None


def _optional_string(value: dict[str, Any], key: str, maximum: int) -> str | None:
    if key not in value:
        return None
    return _bounded_string(value[key], 1, maximum)


def _http_url(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def _valid_iso_datetime(value: str) -> bool:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


__all__ = [
    "ATALK_PROTOCOL_VERSION",
    "ATALK_SDK_VERSION",
    "DEFAULT_RUNTIME_CAPABILITIES",
    "RuntimeCheckIn",
    "RuntimeComponent",
    "RuntimeOptions",
    "RuntimeReleaseChannel",
    "RuntimeUpdateAdvisory",
    "RuntimeUpdatePolicy",
    "RuntimeUpdateSeverity",
    "RuntimeUpdateStatus",
    "parse_runtime_update_advisory",
    "persist_runtime_update_status",
    "resolve_runtime_check_in",
]
