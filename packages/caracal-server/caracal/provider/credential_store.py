"""Provider credential custody helpers."""

from __future__ import annotations

import os
from typing import Any, Dict, Tuple

from caracal.config.encryption import decrypt_value
from caracal.core.vault import SecretNotFound, get_vault, vault_access_context
from caracal.deployment.exceptions import SecretNotFoundError
from caracal.provider.catalog import ensure_identifier


DEFAULT_PROVIDER_ENV_ID = "default"
_PROVIDER_SECRET_SUFFIX = "credential"


def _resolve_vault_environment(env_id: str, vault_client: Any) -> str:
    normalized_env_id = ensure_identifier("Environment ID", env_id)
    if normalized_env_id != DEFAULT_PROVIDER_ENV_ID:
        return normalized_env_id

    configured_env = ""
    config = getattr(vault_client, "_config", None)
    if config is not None:
        configured_env = str(getattr(config, "default_environment", "") or "").strip()

    if not configured_env:
        configured_env = str(
            os.environ.get("CARACAL_VAULT_ENVIRONMENT")
            or os.environ.get("CARACAL_VAULT_ENV")
            or ""
        ).strip()

    if not configured_env:
        return normalized_env_id

    return ensure_identifier("Vault environment", configured_env)


def _workspace_secret_name(workspace: str, secret_name: str) -> str:
    normalized_workspace = ensure_identifier("Workspace name", workspace)
    return f"workspaces/{normalized_workspace}/{secret_name}"


def provider_credential_ref(provider_id: str, env_id: str = DEFAULT_PROVIDER_ENV_ID) -> str:
    normalized_provider_id = ensure_identifier("Provider name", provider_id)
    normalized_env_id = ensure_identifier("Environment ID", env_id)
    return f"caracal:{normalized_env_id}/providers/{normalized_provider_id}/{_PROVIDER_SECRET_SUFFIX}"


def _parse_provider_credential_ref(credential_ref: str) -> Tuple[str, str]:
    clean = str(credential_ref or "").strip()
    if not clean.startswith("caracal:"):
        raise SecretNotFoundError(f"Unsupported provider credential ref: {credential_ref}")

    payload = clean.removeprefix("caracal:")
    if "/" not in payload:
        raise SecretNotFoundError(f"Malformed provider credential ref: {credential_ref}")

    env_id, secret_name = payload.split("/", 1)
    if not env_id or not secret_name:
        raise SecretNotFoundError(f"Malformed provider credential ref: {credential_ref}")
    return env_id, secret_name


def _store_secret(scope_id: str, credential_ref: str, value: str) -> str:
    env_id, secret_name = _parse_provider_credential_ref(credential_ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(env_id, vault_client)
    with vault_access_context():
        vault_client.put(scope_id, vault_env_id, secret_name, value, actor="provider_credential_store")
    return credential_ref


def _resolve_secret(scope_id: str, credential_ref: str) -> str:
    env_id, secret_name = _parse_provider_credential_ref(credential_ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(env_id, vault_client)
    try:
        with vault_access_context():
            return vault_client.get(scope_id, vault_env_id, secret_name, actor="provider_credential_store")
    except SecretNotFound as exc:
        raise SecretNotFoundError(f"Secret not found: {credential_ref}") from exc


def _delete_secret(scope_id: str, credential_ref: str) -> None:
    env_id, secret_name = _parse_provider_credential_ref(credential_ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(env_id, vault_client)
    try:
        with vault_access_context():
            vault_client.delete(scope_id, vault_env_id, secret_name, actor="provider_credential_store")
    except SecretNotFound as exc:
        raise SecretNotFoundError(f"Secret not found: {credential_ref}") from exc


def store_workspace_provider_credential(
    workspace: str,
    provider_id: str,
    value: str,
    env_id: str = DEFAULT_PROVIDER_ENV_ID,
) -> str:
    ref = provider_credential_ref(provider_id, env_id=env_id)
    parsed_env_id, secret_name = _parse_provider_credential_ref(ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(parsed_env_id, vault_client)
    namespaced_secret_name = _workspace_secret_name(workspace, secret_name)
    with vault_access_context():
        vault_client.put("", vault_env_id, namespaced_secret_name, value, actor="provider_credential_store")
    return ref


def resolve_workspace_provider_credential(workspace: str, credential_ref: str) -> str:
    env_id, secret_name = _parse_provider_credential_ref(credential_ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(env_id, vault_client)
    namespaced_secret_name = _workspace_secret_name(workspace, secret_name)
    try:
        with vault_access_context():
            return vault_client.get("", vault_env_id, namespaced_secret_name, actor="provider_credential_store")
    except SecretNotFound:
        return _resolve_secret(workspace, credential_ref)


def delete_workspace_provider_credential(workspace: str, credential_ref: str) -> None:
    env_id, secret_name = _parse_provider_credential_ref(credential_ref)
    vault_client = get_vault()
    vault_env_id = _resolve_vault_environment(env_id, vault_client)
    namespaced_secret_name = _workspace_secret_name(workspace, secret_name)
    try:
        with vault_access_context():
            vault_client.delete("", vault_env_id, namespaced_secret_name, actor="provider_credential_store")
            return
    except SecretNotFound:
        _delete_secret(workspace, credential_ref)


def store_gateway_provider_credential(
    workspace_id: str,
    tier: str,
    provider_id: str,
    value: str,
    env_id: str = DEFAULT_PROVIDER_ENV_ID,
) -> str:
    _ = tier
    ref = provider_credential_ref(provider_id, env_id=env_id)
    return _store_secret(workspace_id, ref, value)


def resolve_gateway_provider_credential(workspace_id: str, tier: str, credential_ref: str) -> str:
    _ = tier
    return _resolve_secret(workspace_id, credential_ref)


def delete_gateway_provider_credential(workspace_id: str, tier: str, credential_ref: str) -> None:
    _ = tier
    _delete_secret(workspace_id, credential_ref)


def migrate_workspace_provider_credentials(
    *,
    workspace: str,
    providers: Dict[str, Dict[str, Any]],
    legacy_secret_refs: Dict[str, str],
    env_id: str = DEFAULT_PROVIDER_ENV_ID,
) -> tuple[Dict[str, Dict[str, Any]], Dict[str, str], bool]:
    updated_providers: Dict[str, Dict[str, Any]] = {
        name: dict(entry or {}) for name, entry in providers.items()
    }
    remaining_legacy_refs = dict(legacy_secret_refs)
    changed = False

    for provider_id, entry in updated_providers.items():
        auth_scheme = str(entry.get("auth_scheme") or "api_key").strip().replace("-", "_").lower()
        if auth_scheme == "none":
            continue

        credential_ref = str(entry.get("credential_ref") or "").strip()
        if credential_ref.startswith("caracal:"):
            continue

        candidate_keys = []
        if credential_ref:
            candidate_keys.append(credential_ref)
        candidate_keys.extend(
            [
                f"provider_{provider_id}_credential",
                f"provider_{provider_id}_api_key",
            ]
        )

        legacy_key = next((key for key in candidate_keys if key in remaining_legacy_refs), None)
        if legacy_key is None:
            continue

        decrypted_value = decrypt_value(remaining_legacy_refs[legacy_key])
        new_ref = store_workspace_provider_credential(
            workspace=workspace,
            provider_id=provider_id,
            value=decrypted_value,
            env_id=env_id,
        )
        entry["credential_ref"] = new_ref
        changed = True

        for key in candidate_keys:
            remaining_legacy_refs.pop(key, None)

    return updated_providers, remaining_legacy_refs, changed
