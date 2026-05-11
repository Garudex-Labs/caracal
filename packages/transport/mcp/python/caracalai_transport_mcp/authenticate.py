# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral MCP authentication: identity verify and revocation check.

from __future__ import annotations

from caracalai_identity import (
    AgentIdentityRequiredError,
    ChainMismatchError,
    DelegationRequiredError,
    JwtConfig,
    ScopeInsufficientError,
    TokenInvalidError,
    ZoneInvalidError,
    verify_config,
)
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
    require_agent: bool = False,
    require_delegation: bool = False,
    require_chain_contains: list[str] | None = None,
) -> AuthResult:
    if not token:
        return AuthResult(None, AuthError("missing_token", "Missing bearer token"))

    cfg = JwtConfig(
        issuer=issuer,
        audience=audience,
        expected_zone_id=expected_zone_id,
        required_scopes=required_scopes or [],
        require_agent=require_agent,
        require_delegation=require_delegation,
        require_chain_contains=require_chain_contains or [],
    )

    try:
        claims = await verify_config(token, cfg)
    except ScopeInsufficientError as err:
        return AuthResult(None, AuthError("insufficient_scope", str(err)))
    except AgentIdentityRequiredError:
        return AuthResult(None, AuthError("agent_required", "Agent identity required"))
    except DelegationRequiredError:
        return AuthResult(None, AuthError("delegation_required", "Delegation required"))
    except ChainMismatchError as err:
        return AuthResult(None, AuthError("chain_mismatch", str(err)))
    except ZoneInvalidError:
        return AuthResult(None, AuthError("invalid_zone", "Token zone validation failed"))
    except TokenInvalidError:
        return AuthResult(None, AuthError("invalid_token", "Token validation failed"))

    if claims.sid and revocations.is_revoked(claims.sid):
        return AuthResult(None, AuthError("session_revoked", "Session revoked"))

    return AuthResult(claims, None)
