"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unified identity service facade for principal registration and spawn flows.
"""

from __future__ import annotations

from typing import Optional

from caracal.core.identity import PrincipalIdentity, PrincipalRegistry
from caracal.core.spawn import SpawnManager, SpawnResult


class IdentityService:
    """Single service entrypoint for principal registration and spawn."""

    def __init__(
        self,
        *,
        principal_registry: PrincipalRegistry,
        spawn_manager: Optional[SpawnManager] = None,
    ) -> None:
        self._principal_registry = principal_registry
        self._spawn_manager = spawn_manager

    def register_principal(
        self,
        *,
        name: str,
        owner: str,
        principal_kind: str,
        metadata: Optional[dict] = None,
        principal_id: Optional[str] = None,
        source_principal_id: Optional[str] = None,
        generate_keys: bool = True,
    ) -> PrincipalIdentity:
        """Register a non-worker principal through the canonical registry path."""
        return self._principal_registry.register_principal(
            name=name,
            owner=owner,
            principal_kind=principal_kind,
            metadata=metadata,
            principal_id=principal_id,
            source_principal_id=source_principal_id,
            generate_keys=generate_keys,
        )

    def spawn_principal(self, **kwargs) -> SpawnResult:
        """Spawn a delegated principal through the canonical spawn manager path."""
        if self._spawn_manager is None:
            raise RuntimeError("IdentityService spawn manager is not configured")
        return self._spawn_manager.spawn_principal(**kwargs)

    def get_principal(self, principal_id: str) -> Optional[PrincipalIdentity]:
        """Fetch principal by ID from canonical registry."""
        return self._principal_registry.get_principal(principal_id)

    def list_principals(self) -> list[PrincipalIdentity]:
        """List principals from canonical registry."""
        return self._principal_registry.list_principals()
