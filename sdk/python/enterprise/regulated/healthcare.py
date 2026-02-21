from caracal._version import get_version
"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Healthcare Regulated Industry Extension (Enterprise Stub).
"""

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class HealthcareExtension(CaracalExtension):
    """Enterprise healthcare regulation extension (HIPAA, HL7 FHIR)."""

    @property
    def name(self) -> str:
        return "regulated-healthcare"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_before_request(self._enforce_phi_protection)

    @staticmethod
    def _enforce_phi_protection(request, scope):
        raise EnterpriseFeatureRequired(
            feature="Healthcare PHI Protection",
            message="HIPAA-compliant PHI protection requires Caracal Enterprise.",
        )
