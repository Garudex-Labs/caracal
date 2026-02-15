"""
Enterprise license validation.

This module provides license validation for Caracal Enterprise features.
In the open source edition, all license validation returns False with
upgrade messaging.
"""

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional


@dataclass
class LicenseValidationResult:
    """
    Result of enterprise license validation.
    
    Attributes:
        valid: Whether the license is valid
        message: Message explaining the validation result
        features_available: List of enterprise features available with this license
        expires_at: License expiration timestamp (None if invalid or no expiration)
    """
    
    valid: bool
    message: str
    features_available: list[str] = field(default_factory=list)
    expires_at: Optional[datetime] = None
    
    def to_dict(self) -> dict:
        """
        Convert result to dictionary format.
        
        Returns:
            Dictionary representation of the validation result
        """
        return {
            "valid": self.valid,
            "message": self.message,
            "features_available": self.features_available,
            "expires_at": self.expires_at.isoformat() if self.expires_at else None,
        }


class EnterpriseLicenseValidator:
    """
    Validates enterprise license tokens.
    
    In the open source edition, this always returns False for license checks,
    displaying enterprise required messages. The actual license validation
    logic is implemented in Caracal Enterprise.
    
    Enterprise License Token Format:
        The license token format is defined by Caracal Enterprise and includes:
        - License type (trial, standard, premium)
        - Organization identifier
        - Feature flags
        - Expiration date
        - Cryptographic signature
        
        Token format: "CE-{version}-{org_id}-{features}-{expiry}-{signature}"
        Example: "CE-1-abc123-sso,analytics-20251231-sig..."
    
    Usage:
        >>> validator = EnterpriseLicenseValidator()
        >>> result = validator.validate_license("CE-1-...")
        >>> if result.valid:
        ...     print("Enterprise features enabled")
        ... else:
        ...     print(result.message)
    """
    
    def validate_license(self, license_token: str, password: Optional[str] = None) -> LicenseValidationResult:
        """
        Validate an enterprise license token.
        
        In the open source edition, this always returns an invalid result
        with upgrade messaging. The actual validation logic is implemented
        in Caracal Enterprise.
        
        Args:
            license_token: The enterprise license token to validate
            password: Optional password for password-protected licenses
        
        Returns:
            LicenseValidationResult indicating the token is invalid in open source
        
        Note:
            In Caracal Enterprise, this method would:
            1. Parse the license token
            2. Verify the cryptographic signature
            3. Check password if token is password-protected
            4. Check expiration date
            5. Validate organization identifier
            6. Return available features
        """
        return LicenseValidationResult(
            valid=False,
            message=(
                "Enterprise license validation requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
            features_available=[],
            expires_at=None,
        )
    
    def get_available_features(self) -> list[str]:
        """
        Get list of available enterprise features.
        
        In the open source edition, this returns an empty list.
        In Caracal Enterprise, this would return the list of features
        enabled by the current license.
        
        Returns:
            Empty list in open source edition
        
        Enterprise Features:
            - sso: Single Sign-On integration
            - analytics: Advanced analytics dashboard
            - workflows: Workflow automation engine
            - compliance: Compliance reporting (SOC 2, ISO 27001)
            - multi_tenancy: Multi-tenancy support
            - priority_support: Priority support access
        """
        return []
    
    def is_feature_available(self, feature: str) -> bool:
        """
        Check if a specific enterprise feature is available.
        
        In the open source edition, this always returns False.
        
        Args:
            feature: Name of the feature to check (e.g., "sso", "analytics")
        
        Returns:
            False in open source edition
        """
        return False
    
    def get_license_info(self) -> dict:
        """
        Get information about the current license.
        
        In the open source edition, this returns information indicating
        no enterprise license is active.
        
        Returns:
            Dictionary with license information
        """
        return {
            "edition": "open_source",
            "license_active": False,
            "features_available": [],
            "upgrade_url": "https://garudexlabs.com",
            "contact_email": "support@garudexlabs.com",
        }
