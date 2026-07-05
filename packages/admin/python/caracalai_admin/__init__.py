"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Python admin client exports.
"""

from __future__ import annotations

from .client import AdminClient
from .control import ControlClient, ControlClientError
from .ensure import (
    GRANT_POLICY_NAME,
    GRANT_POLICY_SET_NAME,
    GovernedUpstream,
    GovernedUpstreamGrant,
    GovernedUpstreamProvider,
    GovernedUpstreamResource,
    GovernedUpstreamResult,
    ResourceGrant,
    author_grants_document,
    ensure_active_policy_set,
    ensure_api_key_provider,
    ensure_application,
    ensure_governed_upstreams,
    ensure_grants,
    ensure_resource,
)
from .errors import AdminApiError
from .identifiers import (
    is_provider_identifier,
    is_resource_identifier,
    provider_identifier,
    resource_identifier,
)

__all__ = [
    "GRANT_POLICY_NAME",
    "GRANT_POLICY_SET_NAME",
    "AdminApiError",
    "AdminClient",
    "ControlClient",
    "ControlClientError",
    "GovernedUpstream",
    "GovernedUpstreamGrant",
    "GovernedUpstreamProvider",
    "GovernedUpstreamResource",
    "GovernedUpstreamResult",
    "ResourceGrant",
    "author_grants_document",
    "ensure_active_policy_set",
    "ensure_api_key_provider",
    "ensure_application",
    "ensure_governed_upstreams",
    "ensure_grants",
    "ensure_resource",
    "is_provider_identifier",
    "is_resource_identifier",
    "provider_identifier",
    "resource_identifier",
]
