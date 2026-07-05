# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Transport-neutral MCP authentication: identity verify and revocation check.

from __future__ import annotations

import re
from typing import Any

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
    warm_jwks,
)
from caracalai_revocation import RevocationStore

from .types import AuthError, AuthOptions, AuthResult, ErrorCode


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
    required_use: str | None = "resource",
) -> AuthResult:
    if not token:
        return AuthResult(None, auth_error("missing_token"))

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
        return AuthResult(None, auth_error("insufficient_scope", str(err)))
    except AgentIdentityRequiredError:
        return AuthResult(None, auth_error("agent_required"))
    except DelegationRequiredError:
        return AuthResult(None, auth_error("delegation_required"))
    except ChainMismatchError as err:
        return AuthResult(None, auth_error("chain_mismatch", str(err)))
    except HopCountExceededError as err:
        return AuthResult(None, auth_error("hop_count_exceeded", str(err)))
    except ZoneInvalidError:
        return AuthResult(None, auth_error("invalid_zone"))
    except TokenInvalidError:
        return AuthResult(None, auth_error("invalid_token"))

    if revocations is None:
        return AuthResult(None, auth_error("invalid_token", "Revocation store required"))
    active_error = check_active_authority(claims, revocations)
    if active_error is not None:
        return AuthResult(None, active_error)

    return AuthResult(claims, None)


async def authenticate_options(token: str, options: AuthOptions) -> AuthResult:
    return await authenticate(
        token,
        options.issuer,
        options.audience,
        options.required_scopes,
        options.expected_zone_id,
        options.revocations,
        require_agent=options.require_agent,
        require_delegation=options.require_delegation,
        require_chain_contains=options.require_chain_contains,
        max_hop_count=options.max_hop_count,
        required_targets=options.required_targets,
        required_use=options.required_use,
    )


class MandateVerifier:
    def __init__(self, defaults: AuthOptions) -> None:
        self.defaults = defaults

    async def authenticate(self, token: str, **overrides: Any) -> AuthResult:
        return await authenticate_options(token, merge_options(self.defaults, overrides))

    async def authorization(self, auth_header: str | None, **overrides: Any) -> AuthResult:
        return await self.authenticate(extract_bearer(auth_header) or "", **overrides)

    def require(self, **overrides: Any) -> "MandateVerifier":
        return MandateVerifier(merge_options(self.defaults, overrides))

    async def warmup(self) -> None:
        # JWKS keysets are zone-scoped; without a configured zone the keyset
        # to warm is unknown until the first token arrives.
        if self.defaults.expected_zone_id:
            await warm_jwks(self.defaults.issuer, self.defaults.expected_zone_id)


def create_mandate_verifier(defaults: AuthOptions) -> MandateVerifier:
    return MandateVerifier(defaults)


def merge_options(defaults: AuthOptions, overrides: dict[str, Any]) -> AuthOptions:
    values = {
        "issuer": defaults.issuer,
        "audience": defaults.audience,
        "revocations": defaults.revocations,
        "required_scopes": defaults.required_scopes,
        "expected_zone_id": defaults.expected_zone_id,
        "require_agent": defaults.require_agent,
        "require_delegation": defaults.require_delegation,
        "require_chain_contains": defaults.require_chain_contains,
        "max_hop_count": defaults.max_hop_count,
        "required_targets": defaults.required_targets,
        "required_use": defaults.required_use,
    }
    for key, value in overrides.items():
        if key in values:
            values[key] = value
    return AuthOptions(**values)


def check_active_authority(claims: object, revocations: RevocationStore, now_seconds: int | None = None) -> AuthError | None:
    import time

    sid = getattr(claims, "sid", "")
    if not sid:
        return auth_error("invalid_token")
    expires_at = getattr(claims, "expires_at", 0)
    if expires_at and expires_at <= (now_seconds if now_seconds is not None else int(time.time())):
        return auth_error("invalid_token", "Token expired during execution")
    for anchor in _revocation_anchors(claims):
        if revocations.is_revoked(anchor):
            return auth_error("session_revoked")
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


def auth_error(code: ErrorCode, description: str | None = None) -> AuthError:
    return AuthError(code, description or default_description(code), default_hint(code))


def http_status_for_auth_error(code: ErrorCode) -> int:
    if code in (
        "insufficient_scope",
        "agent_required",
        "delegation_required",
        "chain_mismatch",
        "hop_count_exceeded",
    ):
        return 403
    return 401


def default_description(code: ErrorCode) -> str:
    if code == "missing_token":
        return "Missing bearer token"
    if code == "invalid_zone":
        return "Token zone validation failed"
    if code == "insufficient_scope":
        return "Required scope is missing"
    if code == "session_revoked":
        return "Session revoked"
    if code == "agent_required":
        return "Agent identity required"
    if code == "delegation_required":
        return "Delegation required"
    if code == "chain_mismatch":
        return "Delegation chain validation failed"
    if code == "hop_count_exceeded":
        return "Hop count exceeded"
    return "Token validation failed"


def default_hint(code: ErrorCode) -> str:
    if code == "missing_token":
        return "Send Authorization: Bearer <Caracal mandate>."
    if code == "invalid_zone":
        return "Check the configured zone ID and the mandate zone_id claim."
    if code == "insufficient_scope":
        return "Request a mandate that includes every required scope for this route."
    if code == "session_revoked":
        return "Refresh the mandate or start a new authorized session."
    if code == "agent_required":
        return "Use an agent-issued resource mandate for this endpoint."
    if code == "delegation_required":
        return "Use a mandate produced by a delegated grant flow."
    if code == "chain_mismatch":
        return "Check require_chain_contains and the mandate delegation chain."
    if code == "hop_count_exceeded":
        return "Reduce delegation depth or raise max_hop_count deliberately."
    return "Check issuer, audience, signature, expiry, token use, scopes, and targets."
