from caracal._version import get_version
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Sync Extension (Enterprise Stub).

Multi-node state synchronization.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations

from typing import Any, Optional

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class SyncExtension(CaracalExtension):
    """Enterprise multi-node sync extension.

    Enables state synchronization across distributed Caracal deployments.

    Args:
        sync_url: URL of the sync coordination service.
        interval: Sync interval in seconds.
    """

    def __init__(
        self,
        sync_url: Optional[str] = None,
        interval: int = 60,
    ) -> None:
        self._sync_url = sync_url
        self._interval = interval

    @property
    def name(self) -> str:
        return "sync"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_state_change(self._sync_state)

    def _sync_state(self, state: Any) -> None:
        raise EnterpriseFeatureRequired(
            feature="State Sync",
            message="Multi-node state synchronization requires Caracal Enterprise.",
        )

    def force_sync(self) -> dict:
        """Force an immediate sync cycle."""
        raise EnterpriseFeatureRequired(
            feature="Force Sync",
            message="Forced sync requires Caracal Enterprise.",
        )

    def get_sync_status(self) -> dict:
        """Get current sync status across nodes."""
        raise EnterpriseFeatureRequired(
            feature="Sync Status",
            message="Sync status queries require Caracal Enterprise.",
        )
