# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# FastMCP auth middleware: validates Caracal JWTs in Python MCP servers.

from __future__ import annotations

import jwt
import json
from typing import Any

from .jwks import JwksCache

_cache = JwksCache()


async def verify_token(
    token: str,
    issuer: str,
    audience: str,
    required_scopes: list[str] | None = None,
    expected_zone_id: str | None = None,
) -> dict[str, Any]:
    keys = await _cache.get_keys(issuer)

    decoded: dict[str, Any] | None = None
    last_err: Exception | None = None
    for key in keys:
        try:
            decoded = jwt.decode(
                token,
                jwt.PyJWK.from_json(json.dumps(key)).key,
                algorithms=["ES256"],
                audience=audience,
                issuer=issuer,
            )
            break
        except Exception as e:
            last_err = e

    if decoded is None:
        raise ValueError(f"Token validation failed: {last_err}")

    scope: str = decoded.get("scope", "")
    zone_id: str | None = decoded.get("zone_id")
    if not zone_id or (expected_zone_id and zone_id != expected_zone_id):
        raise ValueError("Token zone validation failed")
    for required in required_scopes or []:
        if not required or required not in scope.split():
            raise PermissionError(f"Missing required scope: {required}")

    return decoded


class CaracalAuth:
    def __init__(
        self,
        issuer: str,
        audience: str,
        required_scopes: list[str] | None = None,
        expected_zone_id: str | None = None,
    ) -> None:
        self.issuer = issuer
        self.audience = audience
        self.expected_zone_id = expected_zone_id
        self.required_scopes = required_scopes or []

    async def __call__(self, token: str) -> dict[str, Any]:
        return await verify_token(
            token,
            self.issuer,
            self.audience,
            self.required_scopes,
            self.expected_zone_id,
        )
