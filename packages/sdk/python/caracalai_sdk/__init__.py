"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from .client import Caracal, CaracalConfig, GatewayRequest, ResourceBinding
from .context import AuthoritySummary, CaracalContext, capture_context, describe_authority
from .coordinator import AgentKind, CoordinatorClient, DelegationConstraints
from .envelope import Envelope
from .http import CaracalContextASGIMiddleware, Verifier
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import LifecycleHook, ServiceAgent

__all__ = [
    "Caracal",
    "CaracalConfig",
    "CaracalContext",
    "AuthoritySummary",
    "capture_context",
    "describe_authority",
    "CaracalContextASGIMiddleware",
    "Verifier",
    "AgentKind",
    "CoordinatorClient",
    "DelegationConstraints",
    "Envelope",
    "GatewayRequest",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
    "ServiceAgent",
]
