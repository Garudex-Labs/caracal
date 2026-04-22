"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Enterprise-specific exceptions.

This module defines exceptions raised when enterprise features are accessed
in the open source edition.
"""


class EnterpriseFeatureRequired(Exception):
    """
    Exception raised when an enterprise feature is accessed in the open source edition.
    
    This exception provides clear messaging to users about which feature requires
    Caracal Enterprise and how to obtain licensing information.
    
    Attributes:
        feature: Name of the enterprise feature that was accessed
        message: Detailed message explaining the requirement and next steps
    
    Example:
        >>> raise EnterpriseFeatureRequired(
        ...     feature="SSO Authentication",
        ...     message="Single Sign-On integration requires Caracal Enterprise. "
        ...             "Visit https://garudexlabs.com for licensing information."
        ... )
    """
    
    def __init__(self, feature: str, message: str):
        """
        Initialize the exception.
        
        Args:
            feature: Name of the enterprise feature
            message: Detailed message for the user
        """
        self.feature = feature
        self.message = message
        super().__init__(f"Enterprise Feature Required: {feature}. {message}")
    
    def to_dict(self) -> dict:
        """
        Convert exception to dictionary format for API responses.
        
        Returns:
            Dictionary with feature, message, and upgrade information
        """
        return {
            "error": "enterprise_feature_required",
            "feature": self.feature,
            "message": self.message,
            "upgrade_url": "https://garudexlabs.com",
            "contact_email": "support@garudexlabs.com",
        }
