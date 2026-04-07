from __future__ import annotations

import copy

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

    def _store_credential(*, workspace: str, provider_id: str, value: str):
        stored_credentials.append((workspace, provider_id, value))
        return f"caracal:default/providers/{provider_id}/credential"

    monkeypatch.setattr(deployment_cli, "store_workspace_provider_credential", _store_credential)
    monkeypatch.setattr(
        deployment_cli,
        "delete_workspace_provider_credential",
        lambda workspace, credential_ref: deleted_credentials.append((workspace, credential_ref)),
    )
    return registry, saved_snapshots, stored_credentials, deleted_credentials


@pytest.mark.unit
def test_provider_add_creates_passthrough_provider_without_definition(
    provider_cli_env,
) -> None:
    registry, _snapshots, stored_credentials, _deleted = provider_cli_env
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_add,
        [
            "openai-main",
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
def test_provider_add_rejects_enterprise_only_template(provider_cli_env) -> None:
    runner = CliRunner()

    result = runner.invoke(
        deployment_cli.provider_add,
        [
            "storage-main",
            "--template",
            "storage_objects",
            "--credential",
            "secret",
        ],
    )

    assert result.exit_code != 0
    assert "enterprise-only" in result.output


@pytest.mark.unit
def test_provider_enrich_promotes_provider_to_scoped_mode(provider_cli_env) -> None:
    registry, _snapshots, _stored_credentials, _deleted = provider_cli_env
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
        deployment_cli.provider_enrich,
        [
            "openai-main",
            "--resource",
            "models=Model catalog",
            "--action",
            "models:list:GET:/v1/models",
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
    registry, _snapshots, _stored_credentials, _deleted = provider_cli_env
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
            "--clear-definition",
        ],
    )

    assert result.exit_code == 0, result.output
    record = registry["openai-main"]
    assert record["definition"] is None
    assert record["resources"] == []
    assert record["actions"] == []
    assert record["enforce_scoped_requests"] is False


@pytest.mark.unit
def test_provider_update_rejects_clearing_credential_for_authenticated_provider(
    provider_cli_env,
) -> None:
    registry, _snapshots, _stored_credentials, deleted_credentials = provider_cli_env
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
