"""Unit tests for provider credential custody helpers."""

from __future__ import annotations

from contextlib import nullcontext

import pytest

from caracal.core.vault import SecretNotFound
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.provider import credential_store


class _FakeVault:
    def __init__(self) -> None:
        self._values: dict[tuple[str, str, str], str] = {}

    def put(self, scope_id: str, env_id: str, name: str, plaintext: str, actor: str = "provider_credential_store") -> None:
        _ = actor
        self._values[(scope_id, env_id, name)] = plaintext

    def get(self, scope_id: str, env_id: str, name: str, actor: str = "provider_credential_store") -> str:
        _ = actor
        key = (scope_id, env_id, name)
        if key not in self._values:
            raise SecretNotFound(name)
        return self._values[key]

    def delete(self, scope_id: str, env_id: str, name: str, actor: str = "provider_credential_store") -> None:
        _ = actor
        key = (scope_id, env_id, name)
        if key not in self._values:
            raise SecretNotFound(name)
        del self._values[key]


class _ConfiguredFakeVault(_FakeVault):
    class _Config:
        default_environment = "dev"

    def __init__(self) -> None:
        super().__init__()
        self._config = self._Config()


@pytest.mark.unit
def test_workspace_provider_credential_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    fake_vault = _FakeVault()
    monkeypatch.setattr(credential_store, "get_vault", lambda: fake_vault)
    monkeypatch.setattr(credential_store, "vault_access_context", nullcontext)
    monkeypatch.delenv("CARACAL_VAULT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("CARACAL_VAULT_ENV", raising=False)

    ref = credential_store.store_workspace_provider_credential("alpha", "openai-main", "sk-test")

    assert ref == "caracal:default/providers/openai-main/credential"
    assert credential_store.resolve_workspace_provider_credential("alpha", ref) == "sk-test"
    assert fake_vault.get("", "default", "workspaces/alpha/providers/openai-main/credential") == "sk-test"

    credential_store.delete_workspace_provider_credential("alpha", ref)
    with pytest.raises(SecretNotFoundError):
        credential_store.resolve_workspace_provider_credential("alpha", ref)


@pytest.mark.unit
def test_workspace_provider_credential_maps_default_env_to_vault_default_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_vault = _ConfiguredFakeVault()
    monkeypatch.setattr(credential_store, "get_vault", lambda: fake_vault)
    monkeypatch.setattr(credential_store, "vault_access_context", nullcontext)

    ref = credential_store.store_workspace_provider_credential("alpha", "openai-main", "sk-test")

    assert ref == "caracal:default/providers/openai-main/credential"
    assert fake_vault.get("", "dev", "workspaces/alpha/providers/openai-main/credential") == "sk-test"


@pytest.mark.unit
def test_migrate_workspace_provider_credentials_rewrites_legacy_metadata_refs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_vault = _FakeVault()
    monkeypatch.setattr(credential_store, "get_vault", lambda: fake_vault)
    monkeypatch.setattr(credential_store, "vault_access_context", nullcontext)
    monkeypatch.setattr(credential_store, "decrypt_value", lambda encrypted: f"plain::{encrypted}")
    monkeypatch.delenv("CARACAL_VAULT_ENVIRONMENT", raising=False)
    monkeypatch.delenv("CARACAL_VAULT_ENV", raising=False)

    providers = {
        "openai-main": {
            "provider_id": "openai-main",
            "auth_scheme": "bearer",
            "credential_ref": "provider_openai-main_credential",
        },
        "public-health": {
            "provider_id": "public-health",
            "auth_scheme": "none",
            "credential_ref": None,
        },
    }
    legacy_secret_refs = {
        "provider_openai-main_credential": "ENC[v4:opaque]",
        "provider_openai-main_api_key": "ENC[v4:stale]",
    }

    updated_providers, remaining_secret_refs, changed = credential_store.migrate_workspace_provider_credentials(
        workspace="alpha",
        providers=providers,
        legacy_secret_refs=legacy_secret_refs,
    )

    assert changed is True
    assert updated_providers["openai-main"]["credential_ref"] == "caracal:default/providers/openai-main/credential"
    assert updated_providers["public-health"]["credential_ref"] is None
    assert remaining_secret_refs == {}
    assert (
        fake_vault.get("", "default", "workspaces/alpha/providers/openai-main/credential")
        == "plain::ENC[v4:opaque]"
    )
