"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from .client import Caracal, CaracalConfig, GatewayRequest, ResourceBinding
from .context import (
    AuthoritySummary,
    CaracalContext,
    capture_context,
    describe_authority,
)
from .coordinator import CoordinatorClient, DelegationConstraints
from .envelope import Envelope
from .http import CaracalASGIMiddleware, TokenVerifier
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import Grant, LifecycleHook, ServiceAgent

__all__ = [
    "Caracal",
    "CaracalConfig",
    "CaracalContext",
    "AuthoritySummary",
    "capture_context",
    "describe_authority",
    "CaracalASGIMiddleware",
    "TokenVerifier",
    "CoordinatorClient",
    "DelegationConstraints",
    "Envelope",
    "GatewayRequest",
    "Grant",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
    "ServiceAgent",
]
