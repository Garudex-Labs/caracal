"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise-specific exceptions for SDK extension stubs.
"""


class EnterpriseFeatureRequired(Exception):
    """Raised when an enterprise SDK extension is invoked without a license.

    Attributes:
        feature: Name of the enterprise feature that was accessed.
        message: Detailed message explaining upgrade path.
    """

    def __init__(self, feature: str, message: str = "") -> None:
        self.feature = feature
        self.message = message or (
            f"{feature} requires Caracal Enterprise. "
            "Visit https://garudexlabs.com for licensing information."
        )
        super().__init__(f"Enterprise Feature Required: {feature}. {self.message}")

    def to_dict(self) -> dict:
        return {
            "error": "enterprise_feature_required",
            "feature": self.feature,
            "message": self.message,
            "upgrade_url": "https://garudexlabs.com",
            "contact_email": "support@garudexlabs.com",
        }
