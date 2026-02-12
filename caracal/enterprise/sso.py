"""
SSO (Single Sign-On) integration for Caracal Enterprise.

This module provides SSO authentication capabilities for Caracal Enterprise.
In the open source edition, all SSO methods are stubbed and raise
EnterpriseFeatureRequired exceptions.

Supported SSO Providers (Enterprise only):
- SAML 2.0
- OIDC/OAuth 2.0
- Okta
- Azure AD
- Google Workspace
- Custom SSO providers
"""

from abc import ABC, abstractmethod
from typing import Optional

from caracal.enterprise.exceptions import EnterpriseFeatureRequired


class SSOProvider(ABC):
    """
    Abstract base class for SSO providers.
    
    ENTERPRISE ONLY: This feature requires Caracal Enterprise.
    The open source implementation returns an enterprise required message.
    
    SSO providers handle authentication of users via external identity providers,
    mapping external identities to Caracal principals, and managing SSO sessions.
    
    In Caracal Enterprise, implementations would:
    - Validate SSO tokens/assertions
    - Map external user attributes to principal attributes
    - Handle SSO session lifecycle
    - Support multiple SSO protocols (SAML, OIDC, etc.)
    """
    
    @abstractmethod
    def authenticate(self, token: str) -> Optional["Principal"]:
        """
        Authenticate a user via SSO token.
        
        Args:
            token: SSO token or assertion (format depends on provider)
        
        Returns:
            Principal object if authentication succeeds, None otherwise
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Implementation:
            1. Validate token signature and expiration
            2. Extract user attributes from token
            3. Map to existing principal or create new one
            4. Return authenticated principal
        """
        pass
    
    @abstractmethod
    def get_provider_metadata(self) -> dict:
        """
        Get SSO provider configuration metadata.
        
        Returns:
            Dictionary with provider configuration
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Metadata:
            - provider: Provider type (saml, oidc, okta, azure_ad, etc.)
            - entity_id: SSO entity identifier
            - sso_url: SSO endpoint URL
            - logout_url: Logout endpoint URL
            - certificate: Public certificate for validation
            - attribute_mapping: Mapping of SSO attributes to principal fields
        """
        pass
    
    @abstractmethod
    def initiate_login(self, redirect_url: str) -> str:
        """
        Initiate SSO login flow.
        
        Args:
            redirect_url: URL to redirect to after successful authentication
        
        Returns:
            SSO provider login URL
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Implementation:
            Generate SSO request (SAML AuthnRequest or OIDC authorization URL)
            with appropriate parameters and redirect URL.
        """
        pass
    
    @abstractmethod
    def handle_callback(self, callback_data: dict) -> Optional["Principal"]:
        """
        Handle SSO callback after authentication.
        
        Args:
            callback_data: Callback data from SSO provider (SAML response, OIDC code, etc.)
        
        Returns:
            Authenticated principal if successful, None otherwise
        
        Raises:
            EnterpriseFeatureRequired: In open source edition
        
        Enterprise Implementation:
            1. Validate callback data
            2. Exchange authorization code for tokens (OIDC)
            3. Validate assertions/tokens
            4. Create or update principal
            5. Return authenticated principal
        """
        pass


class OpenSourceSSOProvider(SSOProvider):
    """
    Open source SSO stub.
    
    Returns enterprise required message for all authentication attempts.
    This implementation is used in the open source edition to provide
    clear messaging about enterprise requirements.
    
    Usage:
        >>> sso = OpenSourceSSOProvider()
        >>> try:
        ...     principal = sso.authenticate("token")
        ... except EnterpriseFeatureRequired as e:
        ...     print(e.message)
    """
    
    def authenticate(self, token: str) -> Optional["Principal"]:
        """
        Authenticate user via SSO token.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            token: SSO token (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="SSO Authentication",
            message=(
                "Single Sign-On integration requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def get_provider_metadata(self) -> dict:
        """
        Get SSO provider metadata.
        
        In open source, returns minimal metadata indicating enterprise requirement.
        
        Returns:
            Dictionary with enterprise requirement message
        """
        return {
            "provider": "none",
            "enterprise_required": True,
            "message": "SSO providers require Caracal Enterprise.",
            "upgrade_url": "https://garudexlabs.com",
            "contact_email": "support@garudexlabs.com",
        }
    
    def initiate_login(self, redirect_url: str) -> str:
        """
        Initiate SSO login flow.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            redirect_url: Redirect URL (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="SSO Login",
            message=(
                "SSO login flow requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )
    
    def handle_callback(self, callback_data: dict) -> Optional["Principal"]:
        """
        Handle SSO callback.
        
        In open source, this always raises EnterpriseFeatureRequired.
        
        Args:
            callback_data: Callback data (ignored in open source)
        
        Raises:
            EnterpriseFeatureRequired: Always raised in open source
        """
        raise EnterpriseFeatureRequired(
            feature="SSO Callback Handling",
            message=(
                "SSO callback handling requires Caracal Enterprise. "
                "Visit https://garudexlabs.com for licensing information."
            ),
        )


# Convenience function for getting SSO provider
def get_sso_provider(provider_type: str = "default") -> SSOProvider:
    """
    Get SSO provider instance.
    
    In open source, always returns OpenSourceSSOProvider.
    In Caracal Enterprise, returns the appropriate provider based on type.
    
    Args:
        provider_type: Type of SSO provider (saml, oidc, okta, azure_ad, etc.)
    
    Returns:
        SSOProvider instance (OpenSourceSSOProvider in open source)
    
    Enterprise Provider Types:
        - saml: SAML 2.0 provider
        - oidc: OpenID Connect provider
        - okta: Okta integration
        - azure_ad: Azure Active Directory integration
        - google: Google Workspace integration
        - custom: Custom SSO provider
    """
    # In open source, always return the stub
    return OpenSourceSSOProvider()
