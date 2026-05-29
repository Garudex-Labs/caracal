"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Token-exchange client that turns an application client_secret into an STS access token and refreshes it before expiry.
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
    """Exchanges an application client_secret for an STS access token via
    RFC 8693 token exchange, caches the result, and refreshes on demand
    once the cached token approaches its `exp` claim."""

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

    def get_token(self) -> str:
        with self._lock:
            if self._token is not None and self._exp is not None:
                if self._exp - time.time() > REFRESH_LEEWAY_SECONDS:
                    return self._token
            self._refresh()
            assert self._token is not None
            return self._token

    def _refresh(self) -> None:
        data: dict[str, str | list[str]] = {
            "grant_type": GRANT_TYPE,
            "zone_id": self._zone_id,
            "application_id": self._application_id,
            "client_secret": self._client_secret,
            "scope": self._scope,
            "resource": self._resources,
        }
        with httpx.Client(timeout=self._timeout) as http:
            resp = http.post(f"{self._sts_url}/oauth/2/token", data=data)
        resp.raise_for_status()
        body = resp.json()
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("STS response did not contain access_token")
        self._token = token
        self._exp = _decode_jwt_exp(token)
        if self._exp is None:
            expires_in = body.get("expires_in")
            if isinstance(expires_in, (int, float)):
                self._exp = time.time() + float(expires_in)
            else:
                self._exp = time.time() + 600.0
