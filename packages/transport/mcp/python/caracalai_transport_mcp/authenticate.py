# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral MCP authentication: identity verify and revocation check.

from __future__ import annotations

import re

from caracalai_identity import (
    AgentIdentityRequiredError,
    ChainMismatchError,
    DelegationRequiredError,
    HopCountExceededError,
    JwtConfig,
    ScopeInsufficientError,
    TokenInvalidError,
    ZoneInvalidError,
    verify_config,
)
from caracalai_revocation import RevocationStore

from .types import AuthError, AuthResult


def extract_bearer(auth_header: str | None) -> str | None:
    if not auth_header:
        return None
    match = re.match(r"^Bearer\s+(.+)$", auth_header, re.IGNORECASE)
    if not match:
        return None
    token = match.group(1).strip()
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
    max_hop_count: int | None = None,
    required_targets: list[str] | None = None,
    required_use: str | None = "per_call",
) -> AuthResult:
    if not token:
        return AuthResult(None, AuthError("missing_token", "Missing bearer token"))

    cfg = JwtConfig(
        issuer=issuer,
        audience=audience,
        expected_zone_id=expected_zone_id,
        required_scopes=required_scopes or [],
        required_targets=required_targets or [],
        required_use=required_use,
        require_agent=require_agent,
        require_delegation=require_delegation,
        require_chain_contains=require_chain_contains or [],
        max_hop_count=max_hop_count,
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
    except HopCountExceededError as err:
        return AuthResult(None, AuthError("hop_count_exceeded", str(err)))
    except ZoneInvalidError:
        return AuthResult(None, AuthError("invalid_zone", "Token zone validation failed"))
    except TokenInvalidError:
        return AuthResult(None, AuthError("invalid_token", "Token validation failed"))

    if revocations is None:
        return AuthResult(None, AuthError("invalid_token", "Revocation store required"))
    active_error = check_active_authority(claims, revocations)
    if active_error is not None:
        return AuthResult(None, active_error)

    return AuthResult(claims, None)


def check_active_authority(claims: object, revocations: RevocationStore, now_seconds: int | None = None) -> AuthError | None:
    import time

    sid = getattr(claims, "sid", "")
    if not sid:
        return AuthError("invalid_token", "Token validation failed")
    expires_at = getattr(claims, "expires_at", 0)
    if expires_at and expires_at <= (now_seconds if now_seconds is not None else int(time.time())):
        return AuthError("invalid_token", "Token expired during execution")
    for anchor in _revocation_anchors(claims):
        if revocations.is_revoked(anchor):
            return AuthError("session_revoked", "Session revoked")
    return None


def _revocation_anchors(claims: object) -> list[str]:
    anchors = [
        getattr(claims, "sid", None),
        getattr(claims, "root_sid", None),
        getattr(claims, "agent_session_id", None),
        getattr(claims, "delegation_edge_id", None),
    ]
    out: list[str] = []
    for anchor in anchors:
        if isinstance(anchor, str) and anchor and anchor not in out:
            out.append(anchor)
    return out
