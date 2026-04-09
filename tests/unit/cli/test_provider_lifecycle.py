from __future__ import annotations

import copy
import json

from click.testing import CliRunner
import pytest

from caracal.cli import deployment_cli
from caracal.provider.catalog import build_provider_record


class _FakeConfigManager:
    def get_default_workspace_name(self) -> str:
        return "alpha"

    def list_workspaces(self):
        return ["alpha"]


class _FakeEditionAdapter:
    def uses_gateway_execution(self) -> bool:
        return False


@pytest.fixture
def provider_cli_env(monkeypatch: pytest.MonkeyPatch):
    registry: dict[str, dict] = {}
    saved_snapshots: list[dict[str, dict]] = []
    stored_credentials: list[tuple[str, str, str]] = []
    deleted_credentials: list[tuple[str, str]] = []
    sync_calls: list[dict[str, object]] = []

    monkeypatch.setattr(deployment_cli, "ConfigManager", _FakeConfigManager)
    monkeypatch.setattr(
        deployment_cli,
        "get_deployment_edition_adapter",
        lambda: _FakeEditionAdapter(),
    )
    monkeypatch.setattr(
        deployment_cli,
        "load_workspace_provider_registry",
        lambda _config_manager, _workspace: copy.deepcopy(registry),
    )

    def _save_registry(_config_manager, _workspace, providers):
        registry.clear()
        registry.update(copy.deepcopy(providers))
        saved_snapshots.append(copy.deepcopy(providers))

    monkeypatch.setattr(deployment_cli, "save_workspace_provider_registry", _save_registry)

    def _sync_registry_runtime(**kwargs):
        sync_calls.append(dict(kwargs))
        return {"upserted": 0, "disabled": 0, "active": 0, "deactivated_tools": 0, "impacted": []}

    monkeypatch.setattr(
        deployment_cli,
        "sync_workspace_provider_registry_runtime",
        _sync_registry_runtime,
    )

    def _store_credential(*, workspace: str, provider_id: str, value: str):
        stored_credentials.append((workspace, provider_id, value))
        return f"caracal:default/providers/{provider_id}/credential"

    monkeypatch.setattr(deployment_cli, "store_workspace_provider_credential", _store_credential)
    monkeypatch.setattr(
        deployment_cli,
        "delete_workspace_provider_credential",
        lambda workspace, credential_ref: deleted_credentials.append((workspace, credential_ref)),
    )
    return registry, saved_snapshots, stored_credentials, deleted_credentials, sync_calls


@pytest.mark.unit
def test_provider_add_creates_passthrough_provider_without_definition(provider_cli_env) -> None:
    registry, _snapshots, stored_credentials, _deleted, _sync_calls = provider_cli_env
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_add,
        [
            "openai-main",
            "--mode",
            "passthrough",
            "--service-type",
            "ai",
            "--base-url",
            "https://api.example.com",
            "--auth-scheme",
            "bearer",
            "--credential",
            "sk-test",
        ],
    )

    assert result.exit_code == 0, result.output
    assert stored_credentials == [("alpha", "openai-main", "sk-test")]
    record = registry["openai-main"]
    assert record["definition"] is None
    assert record["resources"] == []
    assert record["actions"] == []
    assert record["enforce_scoped_requests"] is False
    assert record["credential_ref"] == "caracal:default/providers/openai-main/credential"


@pytest.mark.unit
def test_provider_add_rejects_scoped_catalog_in_passthrough_mode(provider_cli_env) -> None:
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_add,
        [
            "openai-main",
            "--mode",
            "passthrough",
            "--service-type",
            "ai",
            "--base-url",
            "https://api.example.com",
            "--auth-scheme",
            "bearer",
            "--resource",
            "responses=Responses",
            "--action",
            "responses:create:POST:/v1/responses",
            "--credential",
            "secret",
        ],
    )

    assert result.exit_code != 0
    assert "only valid in scoped mode" in result.output


@pytest.mark.unit
def test_provider_add_scoped_mode_captures_resources_and_actions(provider_cli_env) -> None:
    registry, _snapshots, _stored_credentials, _deleted, _sync_calls = provider_cli_env
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_add,
        [
            "openai-main",
            "--mode",
            "scoped",
            "--service-type",
            "ai",
            "--base-url",
            "https://api.example.com",
            "--auth-scheme",
            "bearer",
            "--resource",
            "models=Model catalog",
            "--action",
            "models:list:GET:/v1/models",
            "--credential",
            "sk-test",
        ],
    )

    assert result.exit_code == 0, result.output
    record = registry["openai-main"]
    assert record["enforce_scoped_requests"] is True
    assert record["resources"] == ["models"]
    assert record["actions"] == ["list"]
    assert record["definition"]["resources"]["models"]["actions"]["list"]["path_prefix"] == "/v1/models"


@pytest.mark.unit
def test_provider_update_can_return_scoped_provider_to_passthrough(provider_cli_env) -> None:
    registry, _snapshots, _stored_credentials, _deleted, sync_calls = provider_cli_env
    registry["openai-main"] = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai-main",
        auth_scheme="bearer",
        base_url="https://api.example.com",
        definition={
            "definition_id": "openai-main",
            "service_type": "ai",
            "display_name": "openai-main",
            "auth_scheme": "bearer",
            "default_base_url": "https://api.example.com",
            "resources": {
                "models": {
                    "description": "Model catalog",
                    "actions": {
                        "list": {
                            "description": "List models",
                            "method": "GET",
                            "path_prefix": "/v1/models",
                        }
                    },
                }
            },
            "metadata": {},
        },
        credential_ref="caracal:default/providers/openai-main/credential",
        enforce_scoped_requests=True,
    )
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_update,
        [
            "openai-main",
            "--mode",
            "passthrough",
        ],
    )

    assert result.exit_code == 0, result.output
    record = registry["openai-main"]
    assert record["definition"] is None
    assert record["resources"] == []
    assert record["actions"] == []
    assert record["enforce_scoped_requests"] is False
    assert len(sync_calls) >= 1


@pytest.mark.unit
def test_provider_update_rejects_clearing_credential_for_authenticated_provider(
    provider_cli_env,
) -> None:
    registry, _snapshots, _stored_credentials, deleted_credentials, _sync_calls = provider_cli_env
    registry["openai-main"] = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai-main",
        auth_scheme="bearer",
        base_url="https://api.example.com",
        definition=None,
        credential_ref="caracal:default/providers/openai-main/credential",
        enforce_scoped_requests=False,
    )
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_update,
        [
            "openai-main",
            "--clear-credential",
        ],
    )

    assert result.exit_code != 0
    assert "require a configured credential" in result.output
    assert deleted_credentials == []


@pytest.mark.unit
def test_provider_remove_deletes_workspace_credential_binding(provider_cli_env) -> None:
    registry, _snapshots, _stored_credentials, deleted_credentials, _sync_calls = provider_cli_env
    registry["openai-main"] = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai-main",
        auth_scheme="bearer",
        base_url="https://api.example.com",
        definition=None,
        credential_ref="caracal:default/providers/openai-main/credential",
        enforce_scoped_requests=False,
    )
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_remove,
        [
            "openai-main",
            "--force",
        ],
    )

    assert result.exit_code == 0, result.output
    assert "openai-main" not in registry
    assert deleted_credentials == [
        ("alpha", "caracal:default/providers/openai-main/credential")
    ]


@pytest.mark.unit
def test_provider_download_writes_provider_json(provider_cli_env, tmp_path) -> None:
    registry, _snapshots, _stored_credentials, _deleted, _sync_calls = provider_cli_env
    registry["openai-main"] = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai-main",
        auth_scheme="bearer",
        base_url="https://api.example.com",
        definition=None,
        credential_ref="caracal:default/providers/openai-main/credential",
        enforce_scoped_requests=False,
    )
    runner = CliRunner()
    output_path = tmp_path / "openai-main.json"

    result = runner.invoke(
        deployment_cli.provider_download,
        ["openai-main", str(output_path)],
    )

    assert result.exit_code == 0, result.output
    exported = json.loads(output_path.read_text(encoding="utf-8"))
    assert exported["provider"]["name"] == "openai-main"


@pytest.mark.unit
def test_provider_import_validates_and_stores_provider_json(provider_cli_env, tmp_path) -> None:
    registry, _snapshots, _stored_credentials, _deleted, _sync_calls = provider_cli_env
    runner = CliRunner()
    input_path = tmp_path / "import-provider.json"
    input_path.write_text(
        """
{
  "provider": {
    "name": "imported-main",
    "service_type": "ai",
    "provider_definition": "imported-main",
    "auth_scheme": "bearer",
    "base_url": "https://api.example.com",
    "credential_ref": "caracal:default/providers/imported-main/credential",
    "enforce_scoped_requests": false
  }
}
""".strip(),
        encoding="utf-8",
    )

    result = runner.invoke(
        deployment_cli.provider_import,
        [str(input_path)],
    )

    assert result.exit_code == 0, result.output
    assert "imported-main" in registry
    assert registry["imported-main"]["service_type"] == "ai"
