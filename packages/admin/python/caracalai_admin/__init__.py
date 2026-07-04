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
    ResourceGrant,
    author_grants_document,
    ensure_active_policy_set,
    ensure_api_key_provider,
    ensure_application,
    ensure_grants,
    ensure_resource,
)
from .errors import AdminApiError

__all__ = [
    "GRANT_POLICY_NAME",
    "GRANT_POLICY_SET_NAME",
    "AdminApiError",
    "AdminClient",
    "ControlClient",
    "ControlClientError",
    "ResourceGrant",
    "author_grants_document",
    "ensure_active_policy_set",
    "ensure_api_key_provider",
    "ensure_application",
    "ensure_grants",
    "ensure_resource",
]
