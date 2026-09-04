import importlib.util
from pathlib import Path
import tomllib

from atalk_hermes import env_enablement, parse_target_ref, validate_target_ref


def test_directory_plugin_manifest_matches_pypi_package():
    directory = Path(__file__).parents[1]
    project = tomllib.loads((directory / "pyproject.toml").read_text())["project"]
    manifest = (directory / "plugin.yaml").read_text()
    assert (directory / "__init__.py").is_file()
    assert (directory / "adapter.py").is_file()
    assert f"version: {project['version']}" in manifest
    assert f'atalk-sdk=={project["version"]}' in manifest


def test_directory_plugin_entrypoint_is_importable():
    directory = Path(__file__).parents[1]
    spec = importlib.util.spec_from_file_location(
        "atalk_directory_plugin",
        directory / "__init__.py",
        submodule_search_locations=[str(directory)],
    )
    assert spec is not None and spec.loader is not None
    plugin = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(plugin)
    assert callable(plugin.register)


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
