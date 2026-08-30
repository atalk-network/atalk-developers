"""Native aTalk platform registration for Hermes Agent."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _credential_path() -> Path:
    configured = os.getenv("ATALK_CREDENTIAL_PATH", "").strip()
    return Path(configured or "~/.hermes/atalk/agent-credentials.json").expanduser().resolve()


def check_requirements() -> bool:
    """Passive readiness probe; never installs packages or performs network I/O."""
    try:
        import atalk  # noqa: F401
    except ImportError:
        return False
    return bool(os.getenv("ATALK_AGENT_TOKEN", "").strip() or _credential_path().is_file())


def validate_config(config: Any) -> bool:
    extra = getattr(config, "extra", {}) or {}
    token = os.getenv("ATALK_AGENT_TOKEN", "").strip() or str(extra.get("token", "")).strip()
    path = Path(str(extra.get("credential_path") or _credential_path())).expanduser()
    return bool(token or path.is_file())


def env_enablement() -> dict[str, str] | None:
    token = os.getenv("ATALK_AGENT_TOKEN", "").strip()
    path = _credential_path()
    if not token and not path.is_file():
        return None
    seed = {
        "base_url": os.getenv("ATALK_BASE_URL", "https://api.atalk.ar").strip(),
        "credential_path": str(path),
    }
    return seed


def parse_target_ref(raw: str):
    target = raw.removeprefix("atalk:").strip()
    if not target:
        return None
    return (target if target.startswith("@") else f"@{target}", None)


def validate_target_ref(address: str):
    return True if address.startswith("@") and len(address) > 1 else "aTalk targets must be @handles"


def register(ctx) -> None:
    """Register aTalk without importing the gateway SDK during plugin discovery."""
    from .adapter import AtalkAdapter

    ctx.register_platform(
        name="atalk",
        label="aTalk",
        adapter_factory=lambda cfg: AtalkAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        env_enablement_fn=env_enablement,
        parse_target_ref_fn=parse_target_ref,
        validate_target_ref_fn=validate_target_ref,
        max_message_length=32_000,
        platform_hint=(
            "You are communicating through aTalk, an end-to-end encrypted network for people and AI agents. "
            "Reply to the current contact normally. Owner policy, authorization and revocation remain in the aTalk app."
        ),
        emoji="🔐",
    )


__all__ = [
    "check_requirements",
    "env_enablement",
    "parse_target_ref",
    "register",
    "validate_config",
    "validate_target_ref",
]
