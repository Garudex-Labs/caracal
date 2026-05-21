# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Verifies a Caracal JWT against an issuer JWKS and enforces zone and scope claims.

from __future__ import annotations

import json

import jwt
from caracalai_core import CaracalError, ErrorCode, JsonValue

from .jwks import JwksCache
from .scope import has_scope
from .types import (
    DEFAULT_MAX_HOP_COUNT,
    MANDATE_USE_RESOURCE,
    MANDATE_USE_SESSION,
    SUBJECT_TYPE_APPLICATION,
    SUBJECT_TYPE_USER,
    ChainHop,
    Claims,
    JwtConfig,
)

_cache = JwksCache()


class TokenInvalidError(CaracalError):
    def __init__(self, description: str = "Token validation failed") -> None:
        super().__init__(ErrorCode.INVALID_TOKEN, description)


class ZoneInvalidError(CaracalError):
    def __init__(self, description: str = "Token zone validation failed") -> None:
        super().__init__(ErrorCode.ZONE_INVALID, description)


class ScopeInsufficientError(CaracalError):
    def __init__(self, missing_scope: str) -> None:
        super().__init__(
            ErrorCode.SCOPE_INSUFFICIENT,
            f"Missing required scope: {missing_scope}",
            details={"missing_scope": missing_scope},
        )
        self.missing_scope = missing_scope


class AgentIdentityRequiredError(CaracalError):
    def __init__(self, description: str = "Agent identity required") -> None:
        super().__init__(ErrorCode.AGENT_IDENTITY_REQUIRED, description)


class DelegationRequiredError(CaracalError):
    def __init__(self, description: str = "Delegation required") -> None:
        super().__init__(ErrorCode.DELEGATION_REQUIRED, description)


class ChainMismatchError(CaracalError):
    def __init__(self, missing_application_id: str) -> None:
        super().__init__(
            ErrorCode.CHAIN_MISMATCH,
            f"Delegation chain missing application: {missing_application_id}",
            details={"missing_application_id": missing_application_id},
        )
        self.missing_application_id = missing_application_id


class HopCountExceededError(CaracalError):
    def __init__(self, description: str = "Hop count exceeded") -> None:
        super().__init__(ErrorCode.HOP_COUNT_EXCEEDED, description)


def _read_chain(raw: object) -> list[ChainHop]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise TokenInvalidError("Token claim delegation_chain must be an array")
    out: list[ChainHop] = []
    for item in raw:
        if not isinstance(item, dict):
            raise TokenInvalidError("Token claim delegation_chain must contain objects")
        application_id = _required_str(item, "application_id")
        out.append(
            ChainHop(
                application_id=application_id,
                agent_session_id=_optional_str(item, "agent_session_id"),
                delegation_edge_id=_optional_str(item, "delegation_edge_id"),
            )
        )
    return out


def _required_str(values: dict[str, object], name: str) -> str:
    value = values.get(name)
    if not isinstance(value, str) or not value:
        raise TokenInvalidError(f"Token claim {name} is required")
    return value


def _optional_str(values: dict[str, object], name: str) -> str | None:
    value = values.get(name)
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise TokenInvalidError(f"Token claim {name} must be a string")
    return value


def _optional_int(values: dict[str, object], name: str) -> int | None:
    value = values.get(name)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise TokenInvalidError(f"Token claim {name} must be a non-negative integer")
    return value


def _required_int(values: dict[str, object], name: str) -> int:
    value = _optional_int(values, name)
    if value is None:
        raise TokenInvalidError(f"Token claim {name} is required")
    return value


def _string_list(values: dict[str, object], name: str) -> list[str]:
    value = values.get(name)
    if value is None:
        return []
    if not isinstance(value, list):
        raise TokenInvalidError(f"Token claim {name} must be a string array")
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item:
            raise TokenInvalidError(f"Token claim {name} must be a string array")
        out.append(item)
    return out


async def verify_token(
    token: str,
    issuer: str,
    audience: str,
    required_scopes: list[str] | None = None,
    expected_zone_id: str | None = None,
    required_use: str | None = None,
) -> dict[str, JsonValue]:
    keys = await _cache.get_keys(issuer)

    try:
        header = jwt.get_unverified_header(token)
    except Exception as e:
        raise TokenInvalidError(f"Token validation failed: {e}") from e

    token_kid = header.get("kid")
    candidates: list[dict[str, JsonValue]]
    if token_kid:
        candidates = [k for k in keys if k.get("kid") == token_kid]
        if not candidates:
            raise TokenInvalidError(f"Token validation failed: unknown kid {token_kid}")
    else:
        candidates = list(keys)

    decoded: dict[str, JsonValue] | None = None
    last_err: Exception | None = None
    for key in candidates:
        try:
            decoded = jwt.decode(
                token,
                jwt.PyJWK.from_json(json.dumps(key)).key,
                algorithms=["ES256"],
                audience=audience,
                issuer=issuer,
                options={"require": ["exp", "iat", "jti", "sub", "sid", "root_sid", "client_id", "use", "sub_type"]},
            )
            break
        except Exception as e:
            last_err = e

    if decoded is None:
        raise TokenInvalidError(f"Token validation failed: {last_err}") from last_err

    _required_str(decoded, "jti")
    _required_str(decoded, "sub")
    _required_str(decoded, "sid")
    _required_str(decoded, "root_sid")
    _required_str(decoded, "client_id")
    token_use = _required_str(decoded, "use")
    if token_use not in {MANDATE_USE_SESSION, MANDATE_USE_RESOURCE}:
        raise TokenInvalidError("Token use validation failed")
    if required_use is not None and token_use != required_use:
        raise TokenInvalidError("Token use validation failed")
    sub_type = _required_str(decoded, "sub_type")
    if sub_type not in {SUBJECT_TYPE_USER, SUBJECT_TYPE_APPLICATION}:
        raise TokenInvalidError("Token subject type validation failed")

    scope = decoded.get("scope", "")
    if not isinstance(scope, str):
        raise TokenInvalidError("Token claim scope must be a string")
    zone_id = decoded.get("zone_id")
    if not isinstance(zone_id, str) or not zone_id or (expected_zone_id and zone_id != expected_zone_id):
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
        required_use=config.required_use,
    )

    agent_session_id = _optional_str(decoded, "agent_session_id")
    delegation_edge_id = _optional_str(decoded, "delegation_edge_id")
    delegation_chain = _read_chain(decoded.get("delegation_chain"))

    if config.require_agent and not agent_session_id:
        raise AgentIdentityRequiredError("Agent identity required")
    if config.require_delegation and not delegation_edge_id:
        raise DelegationRequiredError("Delegation required")
    for expected in config.require_chain_contains:
        present = any(hop.application_id == expected for hop in delegation_chain)
        if not present:
            raise ChainMismatchError(expected)

    hop_count = _optional_int(decoded, "hop_count")
    max_hops = (
        config.max_hop_count
        if config.max_hop_count is not None and config.max_hop_count > 0
        else DEFAULT_MAX_HOP_COUNT
    )
    observed = hop_count if hop_count is not None else 0
    if observed > max_hops:
        raise HopCountExceededError("Hop count exceeded")

    delegation_path = _string_list(decoded, "delegation_path")
    graph_epoch = _optional_int(decoded, "delegation_graph_epoch")
    scope = _required_str(decoded, "scope") if "scope" in decoded else ""
    target_resources = _string_list(decoded, "target")
    for target in config.required_targets:
        if target not in target_resources:
            raise TokenInvalidError("Token target resource validation failed")

    return Claims(
        sub=_required_str(decoded, "sub"),
        zone_id=_required_str(decoded, "zone_id"),
        client_id=_required_str(decoded, "client_id"),
        sid=_required_str(decoded, "sid"),
        root_sid=_required_str(decoded, "root_sid"),
        use=_required_str(decoded, "use"),
        sub_type=_required_str(decoded, "sub_type"),
        jti=_required_str(decoded, "jti"),
        issued_at=_required_int(decoded, "iat"),
        expires_at=_required_int(decoded, "exp"),
        scope=scope,
        target_resources=target_resources,
        agent_session_id=agent_session_id,
        delegation_edge_id=delegation_edge_id,
        source_session_id=_optional_str(decoded, "source_session_id"),
        target_session_id=_optional_str(decoded, "target_session_id"),
        delegation_path=delegation_path,
        delegation_chain=delegation_chain,
        graph_epoch=graph_epoch,
        hop_count=hop_count,
    )


def verify_chain_contains(claims: Claims, application_id: str) -> bool:
    if any(hop.application_id == application_id for hop in claims.delegation_chain):
        return True
    if claims.client_id == application_id:
        return True
    return False
