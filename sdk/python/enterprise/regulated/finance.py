from caracal._version import get_version
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Finance Regulated Industry Extension (Enterprise Stub).
"""

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class FinanceExtension(CaracalExtension):
    """Enterprise financial regulation extension (PCI DSS, SOX)."""

    @property
    def name(self) -> str:
        return "regulated-finance"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_before_request(self._enforce_pci_compliance)

    @staticmethod
    def _enforce_pci_compliance(request, scope):
        raise EnterpriseFeatureRequired(
            feature="Finance PCI Compliance",
            message="PCI DSS compliance enforcement requires Caracal Enterprise.",
        )
