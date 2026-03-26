"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Secret Resolution — tier-aware, gateway-routed.

SecretsAdapter resolves secret refs based on the org's subscription tier.
Secret values are NEVER logged.

Usage:
    adapter = SecretsAdapter(tier="starter", org_id="org-abc")
    value = adapter.resolve("caracal:prod/openai_key")
"""

from __future__ import annotations

import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Sentinel to mark that a value must not be logged
_REDACTED = "<redacted>"

_STARTER_TIERS = {"starter"}
_AWS_TIERS = {"growth", "scale", "enterprise"}


class SecretsAdapterError(Exception):
    """Raised when secret resolution fails."""


class SecretsAdapter:
    """
    Tier-aware secret resolver for SDK consumers.

    Delegates to the appropriate backend based on tier:
      Starter  → CaracalVaultBackend (gateway-side resolution)
      Growth+  → AWSSecretsManagerBackend

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
        from caracalEnterprise.services.gateway.secret_manager import backend_for_tier
        return backend_for_tier(self._tier, self._org_id)

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
        Construct the canonical ref for *name* based on tier.

          Starter  → caracal:{env_id}/{name}
          Growth+  → aws:{org_id}/{env_id}/{name}
        """
        if self._tier in _STARTER_TIERS:
            return f"caracal:{self._env_id}/{name}"
        return f"aws:{self._org_id}/{self._env_id}/{name}"

    @property
    def backend_name(self) -> str:
        return self._backend.name

    @property
    def tier(self) -> str:
        return self._tier
