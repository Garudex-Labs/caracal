# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# ASGI middleware enforcing Caracal mandate verification on inbound HTTP and WebSocket requests.

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from typing import Any

from caracalai_revocation import RevocationStore
from caracalai_verify import (
    AuthError,
    AuthOptions,
    MandateVerifier,
    Principal,
    auth_error,
    extract_bearer,
    http_status_for_auth_error,
)


class CaracalASGIAuth:
    """Pure ASGI middleware that verifies a Caracal mandate on every inbound
    request before it reaches the application. Runs on any ASGI framework
    (FastAPI, Starlette, Quart, Django ASGI) without importing it.

    Verification delegates to ``caracalai_verify``: issuer, audience,
    zone, token use, scopes, targets, delegation chain, hop count, and the
    revocation store are all enforced fail-closed. On success the verified
    claims are stored as ``scope["state"]["caracal"]`` (``request.state.caracal``
    in Starlette/FastAPI); on failure the request is answered with the standard
    401/403 JSON error shape and never reaches the application.

    ``issuer`` defaults to ``CARACAL_STS_URL`` and ``expected_zone_id`` to
    ``CARACAL_ZONE_ID``, so a provider deployed with the standard Caracal
    workload variables only states its own audience and revocation store.

    Per-route requirements come from ``routes``: a mapping of path prefix to
    verification overrides (any :class:`AuthOptions` field). The longest
    matching prefix wins. ``exclude`` lists path prefixes served without
    verification (health and readiness probes).
    """

    def __init__(
        self,
        app: Any,
        *,
        audience: str,
        revocations: RevocationStore,
        issuer: str | None = None,
        expected_zone_id: str | None = None,
        required_scopes: list[str] | None = None,
        required_targets: list[str] | None = None,
        required_use: str | None = "resource",
        require_session: bool = False,
        require_delegation: bool = False,
        require_chain_contains: list[str] | None = None,
        max_hop_count: int | None = None,
        routes: Mapping[str, Mapping[str, Any]] | None = None,
        exclude: list[str] | None = None,
    ) -> None:
        issuer = issuer or os.environ.get("CARACAL_STS_URL", "").rstrip("/")
        if not issuer:
            raise ValueError(
                "CaracalASGIAuth requires an issuer: pass issuer= or set CARACAL_STS_URL"
            )
        if not audience:
            raise ValueError("CaracalASGIAuth requires the provider's own audience")
        expected_zone_id = expected_zone_id or os.environ.get("CARACAL_ZONE_ID")
        if not expected_zone_id:
            raise ValueError(
                "CaracalASGIAuth requires a zone: pass expected_zone_id= or set CARACAL_ZONE_ID"
            )
        self.app = app
        self.verifier = MandateVerifier(
            AuthOptions(
                issuer=issuer,
                audience=audience,
                revocations=revocations,
                required_scopes=required_scopes or [],
                expected_zone_id=expected_zone_id,
                require_session=require_session,
                require_delegation=require_delegation,
                require_chain_contains=require_chain_contains or [],
                max_hop_count=max_hop_count,
                required_targets=required_targets or [],
                required_use=required_use,
            )
        )
        self._routes = sorted(
            (
                (prefix, self.verifier.require(**dict(overrides)))
                for prefix, overrides in (routes or {}).items()
            ),
            key=lambda item: len(item[0]),
            reverse=True,
        )
        self._exclude = list(exclude or [])

    async def warmup(self) -> None:
        """Prefetch the zone's JWKS so the first request does not pay the fetch."""
        await self.verifier.warmup()

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope["type"] not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        if any(_prefix_match(path, prefix) for prefix in self._exclude):
            await self.app(scope, receive, send)
            return
        token = extract_bearer(_header(scope, b"authorization"))
        if token is None:
            await self._reject(scope, send, auth_error("missing_token"))
            return
        result = await self._verifier_for(path).authenticate(token)
        if result.error is not None:
            await self._reject(scope, send, result.error)
            return
        principal: Principal = result.principal
        scope.setdefault("state", {})["caracal"] = principal
        await self.app(scope, receive, send)

    def _verifier_for(self, path: str) -> MandateVerifier:
        for prefix, verifier in self._routes:
            if _prefix_match(path, prefix):
                return verifier
        return self.verifier

    async def _reject(self, scope: dict, send: Any, error: AuthError) -> None:
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = {"error": error.code, "error_description": error.description}
        if error.hint:
            body["error_hint"] = error.hint
        payload = json.dumps(body).encode()
        await send(
            {
                "type": "http.response.start",
                "status": http_status_for_auth_error(error.code),
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(payload)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": payload})


def _header(scope: dict, name: bytes) -> str | None:
    for key, value in scope.get("headers") or []:
        if key == name:
            return value.decode("latin-1")
    return None


def _prefix_match(path: str, prefix: str) -> bool:
    prefix = prefix.rstrip("/") or "/"
    return path == prefix or prefix == "/" or path.startswith(prefix + "/")
