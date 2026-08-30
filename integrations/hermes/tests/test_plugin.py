import os

from atalk_hermes import env_enablement, parse_target_ref, validate_target_ref


def test_target_normalization():
    assert parse_target_ref("atalk:sales.demo") == ("@sales.demo", None)
    assert parse_target_ref("@research.demo") == ("@research.demo", None)
    assert parse_target_ref("  ") is None
    assert validate_target_ref("@sales.demo") is True
    assert isinstance(validate_target_ref("sales.demo"), str)


def test_environment_activation(monkeypatch, tmp_path):
    credentials = tmp_path / "agent.json"
    monkeypatch.setenv("ATALK_CREDENTIAL_PATH", str(credentials))
    monkeypatch.delenv("ATALK_AGENT_TOKEN", raising=False)
    assert env_enablement() is None
    credentials.write_text("{}")
    assert env_enablement() == {
        "base_url": "https://api.atalk.ar",
        "credential_path": str(credentials),
    }


def test_activation_token_enables_without_being_persisted_in_config(monkeypatch, tmp_path):
    monkeypatch.setenv("ATALK_CREDENTIAL_PATH", str(tmp_path / "agent.json"))
    monkeypatch.setenv("ATALK_AGENT_TOKEN", "one-time")
    assert env_enablement() == {
        "base_url": "https://api.atalk.ar",
        "credential_path": str(tmp_path / "agent.json"),
    }
