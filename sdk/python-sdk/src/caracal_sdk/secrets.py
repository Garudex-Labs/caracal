"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Secret Resolution — hard-cut vault-routed.

SecretsAdapter resolves refs via gateway-managed vault backends.
Secret values are NEVER logged.

Usage:
    adapter = SecretsAdapter(tier="starter", org_id="org-abc")
    value = adapter.resolve("caracal:prod/openai_key")
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Sentinel to mark that a value must not be logged
_REDACTED = "<redacted>"


class SecretsAdapterError(Exception):
    """Raised when secret resolution fails."""


class SecretsAdapter:
    """
    Hard-cut secret resolver for SDK consumers.

    All tiers resolve through the gateway/vault path. Tier is retained for
    backend selection metadata and compatibility with enterprise tier lookups.

    Secret values are never included in log output.
    """

    def __init__(self, tier: str, org_id: str, env_id: str = "default") -> None:
        self._tier = tier.lower()
        self._org_id = org_id
        self._env_id = env_id
        self._backend = self._create_backend()
        logger.info(
            "SecretsAdapter initialized (tier=%s, backend=%s)",
            self._tier, self._backend.name,
        )

    def _create_backend(self):
        try:
            from caracalEnterprise.services.gateway.secret_manager import backend_for_tier

            return backend_for_tier(self._tier, self._org_id)
        except ModuleNotFoundError as exc:
            if exc.name != "caracalEnterprise":
                raise

            logger.warning(
                "caracalEnterprise package not available; using SDK local secret backend fallback"
            )
            return _local_backend_for_tier(self._tier, self._org_id)

    def resolve(self, ref: str) -> str:
        """
        Resolve *ref* to a plaintext secret value.

        Raises SecretsAdapterError if the ref cannot be resolved.
        The return value is never logged by this method.
        """
        if not ref:
            raise SecretsAdapterError("Secret ref must not be empty.")
        try:
            value = self._backend.get(ref)
            logger.debug("Resolved secret ref=%r (value: %s)", ref, _REDACTED)
            return value
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to resolve secret ref={ref!r}: {exc}") from exc

    def store(self, ref: str, value: str) -> None:
        """
        Store a secret at *ref*.

        Value is never logged.
        """
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
        """Remove the secret at *ref*."""
        try:
            self._backend.delete(ref)
            logger.info("Deleted secret ref=%r", ref)
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to delete secret ref={ref!r}: {exc}") from exc

    def list_refs(self) -> list[str]:
        """List all secret refs for the configured org and env."""
        try:
            return self._backend.list_refs(self._org_id, self._env_id)
        except Exception as exc:
            raise SecretsAdapterError(f"Failed to list secrets: {exc}") from exc

    def ref_for(self, name: str) -> str:
        """
        Construct the canonical hard-cut ref for *name*.

        All tiers now use CaracalVault refs.
        """
        return f"caracal:{self._env_id}/{name}"

    @property
    def backend_name(self) -> str:
        return self._backend.name

    @property
    def tier(self) -> str:
        return self._tier


class _LocalCaracalVaultBackend:
    """Local fallback backend that talks directly to CaracalVault."""

    def __init__(self, org_id: str) -> None:
        self._org_id = org_id

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
        from caracal.core.vault import get_vault, gateway_context

        with gateway_context():
            return get_vault().get(self._org_id, env_id, name)

    def put(self, ref: str, value: str) -> None:
        env_id, name = self._parse_ref(ref)
        from caracal.core.vault import get_vault, gateway_context

        with gateway_context():
            get_vault().put(self._org_id, env_id, name, value)

    def delete(self, ref: str) -> None:
        env_id, name = self._parse_ref(ref)
        from caracal.core.vault import get_vault, gateway_context

        with gateway_context():
            get_vault().delete(self._org_id, env_id, name)

    def list_refs(self, org_id: str, env_id: str) -> list[str]:
        from caracal.core.vault import get_vault, gateway_context

        with gateway_context():
            names = get_vault().list_secrets(org_id, env_id)
        return [f"caracal:{env_id}/{name}" for name in names]


def _local_backend_for_tier(tier: str, org_id: str):
    if not tier.strip():
        raise SecretsAdapterError("Tier must not be empty for secret management.")
    return _LocalCaracalVaultBackend(org_id=org_id)
