"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Public surface of the Caracal Python SDK.
"""

from .client import Caracal, CaracalConfig, ResourceBinding
from .context import AuthoritySummary, CaracalContext, capture_context, describe_authority
from .coordinator import AgentKind, CoordinatorClient, DelegationConstraints
from .envelope import Envelope
from .http import CaracalContextASGIMiddleware
from .json_types import JsonObject, JsonPrimitive, JsonValue
from .primitives import LifecycleHook

__all__ = [
    "Caracal",
    "CaracalConfig",
    "CaracalContext",
    "AuthoritySummary",
    "capture_context",
    "describe_authority",
    "CaracalContextASGIMiddleware",
    "AgentKind",
    "CoordinatorClient",
    "DelegationConstraints",
    "Envelope",
    "JsonObject",
    "JsonPrimitive",
    "JsonValue",
    "LifecycleHook",
    "ResourceBinding",
]
