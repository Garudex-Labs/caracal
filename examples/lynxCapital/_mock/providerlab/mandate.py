"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Mock Caracal mandate signer and verifier mirroring the verifier SDK boundary semantics for partnership providers.
"""
from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass

import caracalai_identity as identity
import httpx

from _mock.providerlab import jwtmini, partnership

ISSUER = "https://zone.caracal.test"

# Mandate "use" values mirror caracalai_identity: a resource mandate authorizes a
# call against a downstream provider, the audience the verifier binds to.
USE_RESOURCE = "resource"
USE_SESSION = "session"
SUBJECT_TYPES = ("user", "application")


@dataclass
class MandateClaims:
    zone: str
    resource: str
    scopes: list[str]
    subject: str
    session_id: str
    root_session_id: str
    agent_session_id: str | None = None
    delegation_edge_id: str | None = None
    use: str = USE_RESOURCE
    subject_type: str = "application"
    ttl_seconds: int = 300


class VerifyError(Exception):
    """Raised when a mandate fails verification, mirroring verifier SDK error codes."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


async def _verify_caracal(
    token: str, claims: dict, provider_id: str, revoked: set[str], require_delegation: bool
) -> dict:
    """Verify a Caracal STS-issued resource mandate with the verifier kit, pinned to
    the provider's partnered resource-view audiences, then apply the local
    revocation set the way a connector's revocation store would."""
    terms = partnership.for_provider(provider_id)
    if terms is None:
        raise VerifyError(
            "partnership_unconfigured",
            "Caracal partnership terms are not configured for this provider",
        )
    raw_aud = claims.get("aud")
    candidates = [raw_aud] if isinstance(raw_aud, str) else list(raw_aud or [])
    audience = next((a for a in candidates if a in terms.audiences), None)
    if audience is None:
        raise VerifyError("invalid_token", "mandate audience is not a partnered resource view")
    issuer = os.environ.get("CARACAL_STS_ISSUER", "http://localhost:8080").rstrip("/")
    expected_zone = os.environ.get("CARACAL_ZONE_ID", "").strip() or None
    config = identity.JwtConfig(
        issuer=issuer,
        audience=audience,
        expected_zone_id=expected_zone,
        required_use=identity.MANDATE_USE_RESOURCE,
        require_delegation=require_delegation,
    )
    try:
        verified = await identity.verify_config(token, config)
    except identity.DelegationRequiredError as exc:
        raise VerifyError("delegation_required", "resource requires a delegated mandate") from exc
    except identity.ZoneInvalidError as exc:
        raise VerifyError("invalid_zone", "mandate zone mismatch") from exc
    except identity.ScopeInsufficientError as exc:
        raise VerifyError("insufficient_scope", "mandate missing required scopes") from exc
    except identity.TokenInvalidError as exc:
        raise VerifyError("invalid_token", "mandate failed verification") from exc
    except (httpx.HTTPError, OSError) as exc:
        raise VerifyError(
            "verifier_unavailable", "cannot reach Caracal STS for mandate verification"
        ) from exc
    for anchor in (
        verified.sid,
        verified.root_sid,
        verified.agent_session_id,
        verified.delegation_edge_id,
    ):
        if anchor and anchor in revoked:
            raise VerifyError("session_revoked", "mandate anchor revoked")
    # The Gateway narrows a mandate to one resource view rather than to scope
    # strings, so a gateway-minted mandate carries no scope claim; the scopes the
    # partnered view exposes are exactly what that narrowing authorizes.
    scopes = [s for s in verified.scope.split() if s]
    if not scopes:
        scopes = sorted(terms.granted_for(audience))
    return {
        "iss": issuer,
        "aud": audience,
        "zone": verified.zone_id,
        "sub": verified.sub,
        "sub_type": verified.sub_type,
        "use": verified.use,
        "scopes": scopes,
        "sid": verified.sid,
        "root_sid": verified.root_sid,
        "agent_session_id": verified.agent_session_id,
        "delegation_edge_id": verified.delegation_edge_id,
        "jti": verified.jti,
        "issued_by": "caracal",
    }


def sign(claims: MandateClaims, signing_key: str) -> str:
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "aud": claims.resource,
        "zone": claims.zone,
        "sub": claims.subject,
        "sub_type": claims.subject_type,
        "use": claims.use,
        "scopes": claims.scopes,
        "sid": claims.session_id,
        "root_sid": claims.root_session_id,
        "iat": now,
        "exp": now + claims.ttl_seconds,
        "jti": uuid.uuid4().hex,
    }
    if claims.agent_session_id:
        payload["agent_session_id"] = claims.agent_session_id
    if claims.delegation_edge_id:
        payload["delegation_edge_id"] = claims.delegation_edge_id
    return jwtmini.encode(payload, signing_key, kid="zone-signing-key")


async def verify(
    token: str,
    signing_key: str,
    *,
    zone: str,
    resource: str,
    required_scopes: list[str],
    revoked: set[str],
    require_delegation: bool = False,
) -> dict:
    """Verify a mandate the way a Caracal verifier SDK at the upstream boundary would.
    Caracal STS-issued mandates (ES256) verify through the verifier kit against the
    zone JWKS; lab-minted seed mandates (HS256) verify against the provider's local
    signing key."""
    if not token:
        raise VerifyError("missing_token", "no mandate presented")
    try:
        header, payload = jwtmini.peek(token)
    except jwtmini.JwtError as exc:
        raise VerifyError("invalid_token", "mandate malformed") from exc
    if header.get("alg") == "ES256":
        return await _verify_caracal(token, payload, resource, revoked, require_delegation)
    try:
        claims = jwtmini.decode(token, signing_key)
    except jwtmini.JwtError as exc:
        msg = str(exc)
        if "expired" in msg:
            raise VerifyError("invalid_token", "mandate expired") from exc
        raise VerifyError("invalid_token", "mandate signature invalid") from exc
    if claims.get("iss") != ISSUER:
        raise VerifyError("invalid_token", "unexpected issuer")
    if claims.get("use") not in (USE_RESOURCE, USE_SESSION):
        raise VerifyError("invalid_token", "mandate use claim missing or invalid")
    if claims.get("use") != USE_RESOURCE:
        raise VerifyError("invalid_token", "mandate is not a resource mandate")
    if claims.get("sub_type") not in SUBJECT_TYPES:
        raise VerifyError("invalid_token", "mandate subject type invalid")
    if claims.get("zone") != zone:
        raise VerifyError("invalid_zone", "mandate zone mismatch")
    if claims.get("aud") != resource:
        raise VerifyError("invalid_token", "mandate audience mismatch")
    granted = set(claims.get("scopes", []))
    if not set(required_scopes).issubset(granted):
        raise VerifyError("insufficient_scope", "mandate missing required scopes")
    for anchor in ("sid", "root_sid", "agent_session_id", "delegation_edge_id"):
        value = claims.get(anchor)
        if value and value in revoked:
            raise VerifyError("session_revoked", f"mandate anchor revoked: {anchor}")
    if require_delegation and not claims.get("delegation_edge_id"):
        raise VerifyError("delegation_required", "resource requires a delegated mandate")
    return claims
