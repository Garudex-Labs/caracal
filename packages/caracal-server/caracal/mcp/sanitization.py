"""Sanitization helpers for MCP audit and metering metadata."""

from __future__ import annotations

import hashlib
import json


SENSITIVE_METADATA_KEYS = {
    "authorization",
    "auth",
    "auth_header",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api_key",
    "access_token",
    "refresh_token",
    "token",
    "token_subject",
    "task_token_claims",
    "task_caveat_chain",
    "task_caveat_hmac_key",
    "caveat_chain",
    "caveat_hmac_key",
    "caveat_task_id",
    "password",
    "secret",
    "credential",
    "private_key",
    "private_key_pem",
    "provider_secret",
}


def stable_payload_hash(value: object) -> str:
    """Return a deterministic hash for a JSON-like payload without storing it."""
    try:
        payload = json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    except Exception:
        payload = repr(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def sanitize_metadata(value: object) -> object:
    """Remove secret/token material from nested metadata structures."""
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            normalized_key = str(key).strip().lower()
            if normalized_key in SENSITIVE_METADATA_KEYS:
                continue
            if normalized_key == "tool_args":
                sanitized["tool_args_hash"] = stable_payload_hash(item)
                if isinstance(item, dict):
                    sanitized["tool_args_keys"] = sorted(str(arg_key) for arg_key in item.keys())
                continue
            sanitized[str(key)] = sanitize_metadata(item)
        return sanitized
    if isinstance(value, list):
        return [sanitize_metadata(item) for item in value]
    return value
