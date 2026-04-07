from __future__ import annotations

from types import SimpleNamespace

import click
import pytest

from caracal.cli.provider_scopes import validate_provider_scopes
from caracal.provider import credential_store
from caracal.provider.catalog import build_provider_record
from caracal.provider.workspace import (
    list_workspace_action_scopes,
    list_workspace_provider_bindings,
    list_workspace_resource_scopes,
)


class _FakeConfigManager:
    def __init__(self, providers: dict[str, dict]) -> None:
        self._providers = providers

    def get_workspace_config(self, _workspace: str):
        return SimpleNamespace(metadata={"providers": self._providers})

    def _load_vault(self, _workspace: str):
        return {}

    def _save_vault(self, _workspace: str, _secret_refs):
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

    monkeypatch.setattr(
        credential_store,
        "migrate_workspace_provider_credentials",
        lambda **kwargs: (kwargs["providers"], kwargs["legacy_secret_refs"], False),
    )

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
def test_validate_provider_scopes_requires_at_least_one_scoped_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
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
        credential_store,
        "migrate_workspace_provider_credentials",
        lambda **kwargs: (kwargs["providers"], kwargs["legacy_secret_refs"], False),
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

    with pytest.raises(click.ClickException, match="No scoped providers"):
        validate_provider_scopes(
            workspace="alpha",
            resource_scopes=["provider:plain-api:resource:models"],
            action_scopes=[],
        )
