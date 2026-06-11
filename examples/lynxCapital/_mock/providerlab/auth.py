"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Per-category request authenticators that reject calls exactly as the matching real provider would.
"""
from __future__ import annotations

from starlette.requests import Request

from _mock.providerlab import catalog, credentials, mandate


class AuthError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _bearer_from(request: Request, header: str, scheme: str) -> str:
    raw = request.headers.get(header, "")
    if not raw:
        return ""
    if scheme and raw.lower().startswith(scheme.lower() + " "):
        return raw[len(scheme) + 1:].strip()
    return raw.strip()


def authenticate(provider: catalog.Provider, request: Request) -> dict:
    """Validate the inbound credential for a domain call. Returns a principal context."""
    store = credentials.load(provider.id)
    cat = provider.category

    if cat == "none":
        return {"principal": "internal", "auth": "none"}

    if catalog.apikey_auth(provider):
        if provider.apikey_location == "query":
            presented = request.query_params.get(provider.apikey_field, "")
        else:
            presented = request.headers.get(provider.apikey_field, "")
        if not presented:
            raise AuthError(401, "missing_api_key", f"provide {provider.apikey_field}")
        rec = store.find_api_key(presented)
        if rec is None:
            raise AuthError(401, "invalid_api_key", "unknown or revoked API key")
        store.touch("apiKey", presented)
        return {"principal": rec["keyId"], "auth": "api_key"}

    if catalog.bearer_auth(provider):
        presented = _bearer_from(request, provider.auth_header, provider.auth_scheme)
        if not presented:
            raise AuthError(401, "missing_token", f"provide {provider.auth_header}")
        rec = store.find_bearer(presented)
        if rec is None:
            raise AuthError(401, "invalid_token", "unknown or revoked bearer token")
        store.touch("bearer", presented)
        return {"principal": rec["tokenId"], "auth": "bearer_token"}

    if cat in ("oauth2_client_credentials", "oauth2_authorization_code"):
        presented = _bearer_from(request, provider.auth_header, provider.auth_scheme)
        token = store.valid_access_token(presented) if presented else None
        if token is None:
            raise AuthError(401, "invalid_token", "missing or expired access token")
        if provider.audience and token.get("audience") != provider.audience:
            raise AuthError(403, "invalid_audience",
                            f"access token is not authorized for resource {provider.audience}")
        store.touch_client(token["clientId"])
        return {"principal": token["clientId"], "auth": "oauth", "scope": token["scope"]}

    if cat == "caracal_mandate" or (cat == "mcp" and provider.mcp_auth == "mandate"):
        presented = _bearer_from(request, provider.auth_header, provider.auth_scheme)
        try:
            claims = mandate.verify(
                presented,
                store.data["signing_key"],
                zone=store.data["zone"],
                resource=provider.id,
                required_scopes=list(provider.scopes),
                revoked=set(store.data["revoked"]),
                require_delegation=provider.require_delegation,
            )
        except mandate.VerifyError as exc:
            status = 403 if exc.code in ("insufficient_scope", "delegation_required", "session_revoked", "invalid_zone") else 401
            raise AuthError(status, exc.code, exc.message) from exc
        return {
            "principal": claims.get("sub"),
            "auth": "caracal_mandate",
            "scope": claims.get("scopes"),
            "subjectType": claims.get("sub_type"),
            "zone": claims.get("zone"),
            "sessionId": claims.get("sid"),
            "rootSessionId": claims.get("root_sid"),
            "agentSessionId": claims.get("agent_session_id"),
            "delegationEdgeId": claims.get("delegation_edge_id"),
            "mandateId": claims.get("jti"),
        }

    if cat == "mcp" and provider.mcp_auth == "bearer":
        presented = _bearer_from(request, provider.auth_header, provider.auth_scheme)
        rec = store.find_bearer(presented) if presented else None
        if rec is None:
            raise AuthError(401, "invalid_token", "missing or invalid bearer token")
        store.touch("bearer", presented)
        return {"principal": rec["tokenId"], "auth": "bearer_token"}

    raise AuthError(500, "unsupported", f"no authenticator for category {cat}")
