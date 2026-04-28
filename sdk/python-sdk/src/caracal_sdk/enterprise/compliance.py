"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SOC 2, ISO 27001, GDPR compliance reporting.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations
from caracal_sdk._compat import get_version

from typing import NoReturn, Optional

from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.hooks import HookRegistry, ScopeRef, StateSnapshot
from caracal_sdk.transport_types import SDKResponse
from caracal_sdk.enterprise.exceptions import EnterpriseFeatureRequired


class ComplianceExtension(CaracalExtension):
    """Enterprise compliance reporting extension.

    Supports SOC 2, ISO 27001, and GDPR frameworks.

    Args:
        standard: Compliance framework (``"soc2"``, ``"iso27001"``, ``"gdpr"``).
        auto_report: Whether to auto-generate reports on state change.
    """

    def __init__(
        self,
        standard: str = "soc2",
        auto_report: bool = False,
    ) -> None:
        self._standard = standard
        self._auto_report = auto_report

    @property
    def name(self) -> str:
        return "compliance"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        if self._auto_report:
            hooks.on_state_change(self._on_state_change)
        hooks.on_after_response(self._audit_response)

    def _on_state_change(self, state: StateSnapshot) -> None:
        raise EnterpriseFeatureRequired(
            feature="Compliance Auto-Report",
            message=(
                "Automatic compliance reporting requires Caracal Enterprise. "
                f"(state snapshot: {type(state).__name__})"
            ),
        )

    def _audit_response(self, response: SDKResponse, scope: ScopeRef) -> None:
        raise EnterpriseFeatureRequired(
            feature="Compliance Audit",
            message=(
                "Response auditing requires Caracal Enterprise. "
                f"(response: {type(response).__name__}, scope={scope!r})"
            ),
        )

    def generate_report(
        self,
        time_range: tuple[str, str],
        report_type: str = "type2",
    ) -> NoReturn:
        """Generate compliance report for the configured standard."""
        raise EnterpriseFeatureRequired(
            feature=f"Compliance Report ({self._standard})",
            message=(
                f"{self._standard.upper()} compliance reports require Caracal Enterprise. "
                f"(range={time_range!r}, report_type={report_type!r})"
            ),
        )

    def run_compliance_check(self, framework: Optional[str] = None) -> NoReturn:
        """Run automated compliance check."""
        raise EnterpriseFeatureRequired(
            feature="Compliance Check",
            message=(
                "Automated compliance checks require Caracal Enterprise. "
                f"(framework={framework!r})"
            ),
        )
