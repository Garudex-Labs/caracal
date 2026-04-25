from __future__ import annotations

from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from caracal.cli.provider_scopes import validate_provider_scopes
from caracal.provider.catalog import build_provider_record
from caracal.provider.workspace import (
    list_workspace_action_scopes,
    list_workspace_provider_bindings,
    list_workspace_resource_scopes,
    sync_workspace_provider_registry_runtime,
)


class _FakeConfigManager:
    def __init__(self, providers: dict[str, dict]) -> None:
        self._providers = providers

    def get_workspace_config(self, _workspace: str):
        return SimpleNamespace(metadata={"providers": self._providers})

    def _load_secret_refs_or_empty(self, _workspace: str):
        return {}

    def _save_secret_refs(self, _workspace: str, _secret_refs):
        return None


@pytest.mark.unit
def test_workspace_scope_helpers_ignore_passthrough_providers(monkeypatch: pytest.MonkeyPatch) -> None:
    passthrough = build_provider_record(
        name="plain-api",
        service_type="application",
        definition_id="plain-api",
        auth_scheme="bearer",
        base_url="https://plain.example",
        definition=None,
        credential_ref="caracal:default/providers/plain-api/credential",
        enforce_scoped_requests=False,
    )
    scoped = build_provider_record(
        name="scoped-api",
        service_type="application",
        definition_id="scoped-api",
        auth_scheme="bearer",
        base_url="https://scoped.example",
        definition={
            "definition_id": "scoped-api",
            "service_type": "application",
            "display_name": "scoped-api",
            "auth_scheme": "bearer",
            "default_base_url": "https://scoped.example",
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
        credential_ref="caracal:default/providers/scoped-api/credential",
        enforce_scoped_requests=True,
    )
    providers = {"plain-api": passthrough, "scoped-api": scoped}
    config_manager = _FakeConfigManager(providers)

    bindings = list_workspace_provider_bindings(config_manager, "alpha")
    assert [binding.provider_name for binding in bindings] == ["plain-api", "scoped-api"]
    assert bindings[0].is_scoped is False
    assert bindings[1].is_scoped is True

    assert list_workspace_resource_scopes(config_manager, "alpha") == [
        "provider:scoped-api:resource:models"
    ]
    assert list_workspace_action_scopes(config_manager, "alpha") == [
        "provider:scoped-api:action:list"
    ]


@pytest.mark.unit
def test_validate_provider_scopes_noop_when_only_unscoped_pass_through_providers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Passthrough-only registries have no catalog; scope validation is skipped without error."""
    passthrough = build_provider_record(
        name="plain-api",
        service_type="application",
        definition_id="plain-api",
        auth_scheme="bearer",
        base_url="https://plain.example",
        definition=None,
        credential_ref="caracal:default/providers/plain-api/credential",
        enforce_scoped_requests=False,
    )
    config_manager = _FakeConfigManager({"plain-api": passthrough})

    monkeypatch.setattr(
        "caracal.cli.provider_scopes.ConfigManager",
        lambda: config_manager,
    )
    monkeypatch.setattr(
        "caracal.cli.provider_scopes.list_workspace_provider_bindings",
        lambda *_args, **_kwargs: [
            next(
                iter(
                    list_workspace_provider_bindings(
                        config_manager,
                        "alpha",
                    )
                )
            )
        ],
    )

    validate_provider_scopes(
        workspace="alpha",
        resource_scopes=["provider:plain-api:resource:models"],
        action_scopes=[],
    )


class _FakeQuery:
    def __init__(self, rows):
        self._rows = rows

    def filter_by(self, **kwargs):
        filtered = []
        for row in self._rows:
            if all(getattr(row, key, None) == value for key, value in kwargs.items()):
                filtered.append(row)
        return _FakeQuery(filtered)

    def order_by(self, *_args, **_kwargs):
        return self

    def all(self):
        return list(self._rows)


class _FakeSession:
    def __init__(self, rows):
        self._rows = rows

    def query(self, _model):
        return _FakeQuery(self._rows)

    def add(self, row):
        self._rows.append(row)


class _FakeDbManager:
    def __init__(self, rows):
        self._session = _FakeSession(rows)
        self.closed = False

    @contextmanager
    def session_scope(self):
        yield self._session

    def close(self):
        self.closed = True


@pytest.mark.unit
def test_sync_workspace_provider_registry_runtime_upserts_and_disables_removed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    rows = [
        SimpleNamespace(provider_id="legacy", provider_layer="user_provider", enabled=True),
        SimpleNamespace(provider_id="system", provider_layer="system_template", enabled=True),
    ]
    fake_db_manager = _FakeDbManager(rows)
    monkeypatch.setattr(
        "caracal.db.connection.get_db_manager",
        lambda: fake_db_manager,
    )

    provider = build_provider_record(
        name="openai-main",
        service_type="ai",
        definition_id="openai-main",
        auth_scheme="bearer",
        base_url="https://api.example.com",
        definition=None,
        credential_ref="caracal:default/providers/openai-main/credential",
        enforce_scoped_requests=False,
    )
    provider["access_policy"] = {"scopes": ["provider:openai-main:action:list"]}

    result = sync_workspace_provider_registry_runtime(
        workspace="alpha",
        providers={"openai-main": provider},
    )

    assert result["upserted"] == 1
    assert result["disabled"] == 1
    assert result["active"] == 1
    assert result["deactivated_tools"] == 0
    assert result["impacted"] == []
    assert fake_db_manager.closed is True

    legacy = next(row for row in rows if getattr(row, "provider_id", None) == "legacy")
    assert legacy.enabled is False

    synced = next(row for row in rows if getattr(row, "provider_id", None) == "openai-main")
    assert synced.provider_layer == "user_provider"
    assert synced.base_url == "https://api.example.com"
    assert synced.provider_metadata["workspace"] == "alpha"
    assert synced.scopes == ["provider:openai-main:action:list"]
