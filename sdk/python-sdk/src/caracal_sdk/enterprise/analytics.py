"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Analytics Extension (Enterprise Stub).

Advanced analytics export and dashboard integration.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations
from caracal_sdk._compat import get_version

from typing import NoReturn

from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.hooks import HookRegistry, ScopeRef
from caracal_sdk.transport_types import SDKResponse
from caracal_sdk.enterprise.exceptions import EnterpriseFeatureRequired


class AnalyticsExtension(CaracalExtension):
    """Enterprise analytics export extension.

    Args:
        export_interval: Seconds between automatic metric exports.
    """

    def __init__(self, export_interval: int = 300) -> None:
        self._export_interval = export_interval

    @property
    def name(self) -> str:
        return "analytics"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_after_response(self._collect_metrics)

    def _collect_metrics(self, response: SDKResponse, scope: ScopeRef) -> None:
        raise EnterpriseFeatureRequired(
            feature="Analytics Metrics Collection",
            message="Advanced analytics requires Caracal Enterprise.",
        )

    def export(self, format: str = "json") -> NoReturn:
        """Export analytics data."""
        raise EnterpriseFeatureRequired(
            feature="Analytics Export",
            message="Analytics data export requires Caracal Enterprise.",
        )

    def get_dashboard_url(self) -> str:
        """Get analytics dashboard URL."""
        raise EnterpriseFeatureRequired(
            feature="Analytics Dashboard",
            message="Analytics dashboard requires Caracal Enterprise.",
        )
