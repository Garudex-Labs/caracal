from caracal._version import get_version
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Compliance Extension (Enterprise Stub).

SOC 2, ISO 27001, GDPR, HIPAA compliance reporting.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations

from typing import Any, Optional

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class ComplianceExtension(CaracalExtension):
    """Enterprise compliance reporting extension.

    Supports SOC 2, ISO 27001, GDPR, HIPAA frameworks.

    Args:
        standard: Compliance framework (``"soc2"``, ``"iso27001"``, ``"gdpr"``, ``"hipaa"``).
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

    def _on_state_change(self, state: Any) -> None:
        raise EnterpriseFeatureRequired(
            feature="Compliance Auto-Report",
            message="Automatic compliance reporting requires Caracal Enterprise.",
        )

    def _audit_response(self, response: Any, scope: Any) -> None:
        raise EnterpriseFeatureRequired(
            feature="Compliance Audit",
            message="Response auditing requires Caracal Enterprise.",
        )

    def generate_report(
        self,
        time_range: tuple[str, str],
        report_type: str = "type2",
    ) -> bytes:
        """Generate compliance report for the configured standard."""
        raise EnterpriseFeatureRequired(
            feature=f"Compliance Report ({self._standard})",
            message=f"{self._standard.upper()} compliance reports require Caracal Enterprise.",
        )

    def run_compliance_check(self, framework: Optional[str] = None) -> dict:
        """Run automated compliance check."""
        raise EnterpriseFeatureRequired(
            feature="Compliance Check",
            message="Automated compliance checks require Caracal Enterprise.",
        )
