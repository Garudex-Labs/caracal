"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Canonical error codes and exception type shared across Caracal Python packages.
"""

from __future__ import annotations

from .json_types import JsonObject, JsonValue


class ErrorCode:
    ACCESS_DENIED = "access_denied"
    INVALID_TOKEN = "invalid_token"
    RESOURCE_NOT_FOUND = "resource_not_found"
    INTERNAL = "internal_error"
    POLICY_EVAL_FAILED = "policy_eval_failed"
    PROVIDER_RATE_LIMITED = "provider_rate_limited"
    INTERACTION_REQUIRED = "interaction_required"
    STS_UNAVAILABLE = "sts_unavailable"
    CREDENTIAL_EXPIRED = "credential_expired_not_renewable"
    PAYLOAD_TOO_LARGE = "payload_too_large"
    ZONE_INVALID = "zone_invalid"
    SCOPE_INSUFFICIENT = "scope_insufficient"
    AGENT_IDENTITY_REQUIRED = "agent_identity_required"
    DELEGATION_REQUIRED = "delegation_required"
    CHAIN_MISMATCH = "chain_mismatch"
    HOP_COUNT_EXCEEDED = "hop_count_exceeded"
    HTTP_REQUEST_FAILED = "http_request_failed"
    CONFIG_MISSING = "config_missing"


class CaracalError(Exception):
    """Canonical Caracal error carrying a stable wire code, human description,
    optional request id, and optional structured details."""

    def __init__(
        self,
        code: str,
        description: str,
        *,
        request_id: str | None = None,
        details: JsonObject | None = None,
    ) -> None:
        super().__init__(description)
        self.code = code
        self.description = description
        self.request_id = request_id
        self.details = details

    def __str__(self) -> str:
        return f"{self.code}: {self.description}"

    def to_json(self) -> dict[str, JsonValue]:
        out: dict[str, JsonValue] = {
            "error": self.code,
            "error_description": self.description,
        }
        if self.request_id:
            out["requestId"] = self.request_id
        if self.details:
            out["details"] = self.details
        return out
