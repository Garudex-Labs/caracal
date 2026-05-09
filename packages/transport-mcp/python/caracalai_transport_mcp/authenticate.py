# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral MCP authentication: identity verify and revocation check.

from __future__ import annotations

from caracalai_identity import verify_token
from caracalai_revocation import RevocationStore

from .types import AuthError, AuthResult


def extract_bearer(auth_header: str | None) -> str | None:
    if not auth_header or not auth_header.startswith("Bearer ") or len(auth_header) <= 7:
        return None
    token = auth_header[7:].strip()
    return token or None


async def authenticate(
    token: str,
    issuer: str,
    audience: str,
    required_scopes: list[str] | None,
    expected_zone_id: str | None,
    revocations: RevocationStore,
) -> AuthResult:
    if not token:
        return AuthResult(None, AuthError("missing_token", "Missing bearer token"))

    try:
        claims = await verify_token(token, issuer, audience, required_scopes, expected_zone_id)
    except PermissionError as err:
        return AuthResult(None, AuthError("insufficient_scope", str(err)))
    except ValueError as err:
        message = str(err)
        if "zone" in message.lower():
            return AuthResult(None, AuthError("invalid_zone", "Token zone validation failed"))
        return AuthResult(None, AuthError("invalid_token", "Token validation failed"))

    sid = claims.get("sid")
    if isinstance(sid, str) and sid and revocations.is_revoked(sid):
        return AuthResult(None, AuthError("session_revoked", "Session revoked"))

    return AuthResult(claims, None)
