# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

from __future__ import annotations

import json
from typing import Any

import jwt

from .jwks import JwksCache
from .scope import has_scope
from .types import ChainHop, Claims, JwtConfig

_cache = JwksCache()


class TokenInvalidError(ValueError):
    pass


class ZoneInvalidError(ValueError):
    pass


class ScopeInsufficientError(PermissionError):
    def __init__(self, missing_scope: str) -> None:
        super().__init__(f"Missing required scope: {missing_scope}")
        self.missing_scope = missing_scope


class AgentIdentityRequiredError(PermissionError):
    pass


class DelegationRequiredError(PermissionError):
    pass


class ChainMismatchError(PermissionError):
    def __init__(self, missing_application_id: str) -> None:
        super().__init__(f"Delegation chain missing application: {missing_application_id}")
        self.missing_application_id = missing_application_id


class HopCountExceededError(PermissionError):
    pass


def _read_chain(raw: Any) -> list[ChainHop]:
    if not isinstance(raw, list):
        return []
    out: list[ChainHop] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        application_id = item.get("app") or item.get("application_id")
        if not isinstance(application_id, str) or not application_id:
            continue
        out.append(
            ChainHop(
                application_id=application_id,
                agent_session_id=item.get("session") or item.get("agent_session_id"),
                delegation_edge_id=item.get("edge") or item.get("delegation_edge_id"),
            )
        )
    return out


async def verify_token(
    token: str,
    issuer: str,
    audience: str,
    required_scopes: list[str] | None = None,
    expected_zone_id: str | None = None,
) -> dict[str, Any]:
    keys = await _cache.get_keys(issuer)

    try:
        header = jwt.get_unverified_header(token)
    except Exception as e:
        raise TokenInvalidError(f"Token validation failed: {e}") from e

    token_kid = header.get("kid")
    candidates: list[dict[str, Any]]
    if token_kid:
        candidates = [k for k in keys if k.get("kid") == token_kid]
        if not candidates:
            raise TokenInvalidError(f"Token validation failed: unknown kid {token_kid}")
    else:
        candidates = list(keys)

    decoded: dict[str, Any] | None = None
    last_err: Exception | None = None
    for key in candidates:
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
        raise TokenInvalidError(f"Token validation failed: {last_err}")

    scope: str = decoded.get("scope", "")
    zone_id: str | None = decoded.get("zone_id")
    if not zone_id or (expected_zone_id and zone_id != expected_zone_id):
        raise ZoneInvalidError("Token zone validation failed")
    for required in required_scopes or []:
        if not has_scope(scope, required):
            raise ScopeInsufficientError(required)

    return decoded


async def verify_config(token: str, config: JwtConfig) -> Claims:
    decoded = await verify_token(
        token,
        issuer=config.issuer,
        audience=config.audience,
        required_scopes=config.required_scopes,
        expected_zone_id=config.expected_zone_id,
    )

    agent_session_id = decoded.get("agent_session_id")
    delegation_edge_id = decoded.get("delegation_edge_id")
    delegation_chain = _read_chain(decoded.get("delegation_chain"))

    if config.require_agent and not agent_session_id:
        raise AgentIdentityRequiredError("Agent identity required")
    if config.require_delegation and not delegation_edge_id:
        raise DelegationRequiredError("Delegation required")
    for expected in config.require_chain_contains:
        present = any(hop.application_id == expected for hop in delegation_chain)
        if not present:
            raise ChainMismatchError(expected)

    hop_count = decoded.get("hop_count")
    if (
        config.max_hop_count is not None
        and isinstance(hop_count, int)
        and hop_count > config.max_hop_count
    ):
        raise HopCountExceededError("Hop count exceeded")

    delegation_path = decoded.get("delegation_path") or []
    if not isinstance(delegation_path, list):
        delegation_path = []

    graph_epoch = decoded.get("delegation_graph_epoch")
    if graph_epoch is None:
        graph_epoch = decoded.get("graph_epoch")

    return Claims(
        sub=decoded.get("sub", ""),
        zone_id=decoded.get("zone_id", ""),
        client_id=decoded.get("client_id", ""),
        sid=decoded.get("sid", ""),
        scope=decoded.get("scope", ""),
        agent_session_id=agent_session_id,
        delegation_edge_id=delegation_edge_id,
        source_session_id=decoded.get("source_session_id"),
        target_session_id=decoded.get("target_session_id"),
        delegation_path=[v for v in delegation_path if isinstance(v, str)],
        delegation_chain=delegation_chain,
        graph_epoch=graph_epoch if isinstance(graph_epoch, int) else None,
        hop_count=decoded.get("hop_count") if isinstance(decoded.get("hop_count"), int) else None,
    )


def verify_chain_contains(claims: Claims, application_id: str) -> bool:
    if any(hop.application_id == application_id for hop in claims.delegation_chain):
        return True
    if claims.client_id == application_id:
        return True
    return False
