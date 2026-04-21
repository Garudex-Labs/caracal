"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SSO Extension (Enterprise Stub).

Single Sign-On provider integration.
In the open-source edition, all methods raise EnterpriseFeatureRequired.
"""

from __future__ import annotations
from caracal_sdk._compat import get_version

from typing import NoReturn, Optional

from caracal_sdk.extensions import CaracalExtension
from caracal_sdk.hooks import HookRegistry, ScopeRef
from caracal_sdk.json_types import JsonObject
from caracal_sdk.transport_types import SDKRequest
from caracal_sdk.enterprise.exceptions import EnterpriseFeatureRequired


class SSOExtension(CaracalExtension):
    """Enterprise SSO provider extension.

    Supports SAML 2.0, OIDC, and LDAP providers.

    Args:
        provider: SSO provider type (``"saml"``, ``"oidc"``, ``"ldap"``).
        config: Provider-specific configuration dictionary.
    """

    def __init__(
        self,
        provider: str = "oidc",
        config: JsonObject | None = None,
    ) -> None:
        self._provider = provider
        self._config = config or {}

    @property
    def name(self) -> str:
        return "sso"

    @property
    def version(self) -> str:
        return get_version()

    def install(self, hooks: HookRegistry) -> None:
        hooks.on_before_request(self._inject_sso_token)

    def _inject_sso_token(self, request: SDKRequest, scope: ScopeRef) -> SDKRequest:
        raise EnterpriseFeatureRequired(
            feature="SSO Token Injection",
            message="SSO integration requires Caracal Enterprise.",
        )

    def authenticate(self, credentials: JsonObject) -> NoReturn:
        """Authenticate via SSO provider."""
        raise EnterpriseFeatureRequired(
            feature=f"SSO Authentication ({self._provider})",
            message=f"{self._provider.upper()} SSO authentication requires Caracal Enterprise.",
        )

    def get_user_info(self, token: str) -> NoReturn:
        """Get user info from SSO token."""
        raise EnterpriseFeatureRequired(
            feature="SSO User Info",
            message="SSO user info retrieval requires Caracal Enterprise.",
        )
