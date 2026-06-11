"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Token-exchange client that turns an application client_secret into STS access tokens and resource mandates, refreshing each before expiry.
"""

from __future__ import annotations

import base64
import binascii
import json
import threading
import time
from collections.abc import Callable

import httpx

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
REFRESH_LEEWAY_SECONDS = 60
DEFAULT_TIMEOUT_SECONDS = 5.0


TokenSource = Callable[[], str]


def _decode_jwt_exp(token: str) -> float | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        return float(exp)
    return None


class ClientSecretExchanger:
    """Exchanges an application client_secret for STS tokens via RFC 8693
    token exchange: a lifecycle access token for the application itself, and
    per-agent resource mandates bound to an agent session and delegation edge.
    Every result is cached and refreshed on demand once it approaches its
    `exp` claim."""

    def __init__(
        self,
        *,
        sts_url: str,
        zone_id: str,
        application_id: str,
        client_secret: str,
        resources: list[str],
        scope: str = "agent:lifecycle",
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        http_client: httpx.Client | None = None,
    ) -> None:
        if not resources:
            raise ValueError("ClientSecretExchanger requires at least one resource")
        self._sts_url = sts_url.rstrip("/")
        self._zone_id = zone_id
        self._application_id = application_id
        self._client_secret = client_secret
        self._resources = list(resources)
        self._scope = scope
        self._timeout = timeout_seconds
        self._lock = threading.Lock()
        self._token: str | None = None
        self._exp: float | None = None
        self._mandates: dict[
            tuple[str, frozenset[str], str | None, str | None], tuple[str, float]
        ] = {}
        self._http_client = http_client

    def get_token(self) -> str:
        with self._lock:
            if self._token is not None and self._exp is not None:
                if self._exp - time.time() > REFRESH_LEEWAY_SECONDS:
                    return self._token
            self._token, self._exp = self._exchange(
                {
                    "grant_type": GRANT_TYPE,
                    "zone_id": self._zone_id,
                    "application_id": self._application_id,
                    "client_secret": self._client_secret,
                    "scope": self._scope,
                    "resource": self._resources,
                }
            )
            return self._token

    def invalidate(self) -> None:
        """Drop the cached lifecycle token so the next get_token() exchanges a
        fresh one. Called when a verifier rejects the token before its `exp`,
        e.g. after server-side session revocation."""
        with self._lock:
            self._token = None
            self._exp = None

    def mint_mandate(
        self,
        *,
        resource: str,
        scopes: list[str],
        agent_session_id: str | None = None,
        delegation_edge_id: str | None = None,
        ttl_seconds: int | None = None,
    ) -> str:
        """Exchange the application credential for a resource mandate audienced
        to one resource and narrowed to the requested scopes. Pass the calling
        agent's session and delegation edge so the STS evaluates policy against
        that agent's authority and the mandate carries its identity."""
        if not resource:
            raise ValueError("mint_mandate requires a resource")
        if not scopes:
            raise ValueError("mint_mandate requires at least one scope")
        key = (resource, frozenset(scopes), agent_session_id, delegation_edge_id)
        with self._lock:
            cached = self._mandates.get(key)
            if cached is not None and cached[1] - time.time() > REFRESH_LEEWAY_SECONDS:
                return cached[0]
            data: dict[str, str | list[str]] = {
                "grant_type": GRANT_TYPE,
                "zone_id": self._zone_id,
                "application_id": self._application_id,
                "client_secret": self._client_secret,
                "scope": " ".join(sorted(scopes)),
                "resource": resource,
            }
            if agent_session_id:
                data["agent_session_id"] = agent_session_id
            if delegation_edge_id:
                data["delegation_edge_id"] = delegation_edge_id
            if ttl_seconds is not None:
                data["ttl_seconds"] = str(ttl_seconds)
            token, exp = self._exchange(data)
            self._mandates[key] = (token, exp)
            return token

    def _exchange(self, data: dict[str, str | list[str]]) -> tuple[str, float]:
        if self._http_client is not None:
            resp = self._http_client.post(f"{self._sts_url}/oauth/2/token", data=data)
        else:
            with httpx.Client(timeout=self._timeout) as http:
                resp = http.post(f"{self._sts_url}/oauth/2/token", data=data)
        resp.raise_for_status()
        body = resp.json()
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("STS response did not contain access_token")
        exp = _decode_jwt_exp(token)
        if exp is None:
            expires_in = body.get("expires_in")
            if isinstance(expires_in, (int, float)):
                exp = time.time() + float(expires_in)
            else:
                exp = time.time() + 600.0
        return token, exp
