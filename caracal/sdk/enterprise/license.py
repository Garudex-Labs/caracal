"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

License Validation Extension (Enterprise Stub).

Enterprise license management and validation.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations

from typing import Any, Optional

from caracal.sdk.extensions import CaracalExtension
from caracal.sdk.hooks import HookRegistry
from caracal.sdk.enterprise.exceptions import EnterpriseFeatureRequired


class LicenseExtension(CaracalExtension):
    """Enterprise license validation extension.

    Validates enterprise license keys and manages feature entitlements.

    Args:
        license_key: Enterprise license key.
    """

    def __init__(self, license_key: Optional[str] = None) -> None:
        self._license_key = license_key

    @property
    def name(self) -> str:
        return "license"

    @property
    def version(self) -> str:
        return "0.1.0"

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_initialize(self._validate_license)

    def _validate_license(self) -> None:
        raise EnterpriseFeatureRequired(
            feature="License Validation",
            message="License validation requires Caracal Enterprise.",
        )

    def validate(self) -> dict:
        """Validate the current license key."""
        raise EnterpriseFeatureRequired(
            feature="License Validation",
            message="License validation requires Caracal Enterprise.",
        )

    def get_entitlements(self) -> list:
        """Get feature entitlements for the current license."""
        raise EnterpriseFeatureRequired(
            feature="License Entitlements",
            message="License entitlement queries require Caracal Enterprise.",
        )
