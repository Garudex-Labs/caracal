"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Secret resolution adapter for Caracal control surfaces.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)
_REDACTED = "<redacted>"


class SecretsAdapterError(Exception):
    """Raised when secret resolution fails."""


class SecretsAdapter:
    """Resolve, store, delete, and list secrets using CaracalVault."""

    def __init__(self, workspace_id: str, env_id: str = "default") -> None:
        self._workspace_id = workspace_id
        self._env_id = env_id
        self._backend = _LocalCaracalVaultBackend(workspace_id=workspace_id)
        logger.info(
            "SecretsAdapter initialized (backend=%s)",
            self._backend.name,
        )

    def resolve(self, ref: str) -> str:
        if not ref:
            raise SecretsAdapterError("Secret ref must not be empty.")
        try:
            value = self._backend.get(ref)
            logger.debug("Resolved secret ref=%r (value: %s)", ref, _REDACTED)
            return value
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to resolve secret ref={ref!r}: {exc}") from exc

    def store(self, ref: str, value: str) -> None:
        if not ref:
            raise SecretsAdapterError("Secret ref must not be empty.")
        if not value:
            raise SecretsAdapterError("Secret value must not be empty.")
        try:
            self._backend.put(ref, value)
            logger.info("Stored secret ref=%r (value: %s)", ref, _REDACTED)
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to store secret ref={ref!r}: {exc}") from exc

    def delete(self, ref: str) -> None:
        try:
            self._backend.delete(ref)
            logger.info("Deleted secret ref=%r", ref)
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to delete secret ref={ref!r}: {exc}") from exc

    def list_refs(self) -> list[str]:
        try:
            return self._backend.list_refs(self._workspace_id, self._env_id)
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to list secrets: {exc}") from exc

    def ref_for(self, name: str) -> str:
        return f"caracal:{self._env_id}/{name}"

    @property
    def backend_name(self) -> str:
        return self._backend.name


class _LocalCaracalVaultBackend:
    def __init__(self, workspace_id: str) -> None:
        self._workspace_id = workspace_id

    @property
    def name(self) -> str:
        return "caracal_vault"

    def _parse_ref(self, ref: str) -> tuple[str, str]:
        clean = ref.removeprefix("caracal:").strip()
        if "/" not in clean:
            raise SecretsAdapterError(
                f"Invalid CaracalVault ref format: {ref!r}. Expected 'caracal:{{env_id}}/{{secret_name}}'."
            )
        return clean.split("/", 1)

    def get(self, ref: str) -> str:
        env_id, name = self._parse_ref(ref)
        from caracal.core.vault import get_vault, vault_access_context

        with vault_access_context():
            return get_vault().get(self._workspace_id, env_id, name)

    def put(self, ref: str, value: str) -> None:
        env_id, name = self._parse_ref(ref)
        from caracal.core.vault import get_vault, vault_access_context

        with vault_access_context():
            get_vault().put(self._workspace_id, env_id, name, value)

    def delete(self, ref: str) -> None:
        env_id, name = self._parse_ref(ref)
        from caracal.core.vault import get_vault, vault_access_context

        with vault_access_context():
            get_vault().delete(self._workspace_id, env_id, name)

    def list_refs(self, workspace_id: str, env_id: str) -> list[str]:
        from caracal.core.vault import get_vault, vault_access_context

        with vault_access_context():
            names = get_vault().list_secrets(workspace_id, env_id)
        return [f"caracal:{env_id}/{name}" for name in names]

