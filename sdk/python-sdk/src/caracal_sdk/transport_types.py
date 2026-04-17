"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Shared transport request and response types.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from caracal_sdk.json_types import JsonObject, JsonValue, QueryParams


@dataclass
class SDKRequest:
    """Outbound SDK request representation."""

    method: str
    path: str
    headers: dict[str, str] = field(default_factory=dict)
    body: JsonObject | None = None
    params: QueryParams | None = None


@dataclass
class SDKResponse:
    """Inbound SDK response representation."""

    status_code: int
    headers: dict[str, str] = field(default_factory=dict)
    body: JsonValue | None = None
    elapsed_ms: float = 0.0
