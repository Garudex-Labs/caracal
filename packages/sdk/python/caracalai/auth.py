"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Token-exchange client that turns an application client_secret into STS access tokens and resource mandates, refreshing each before expiry.
"""

from __future__ import annotations

import base64
import binascii
import json
import random
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from email.utils import parsedate_to_datetime

import httpx

from .errors import ApprovalRequired, raise_for_caracal_error

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
MAX_LEEWAY_SECONDS = 60.0
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_RETRIES = 3
MANDATE_CACHE_CAP = 10_000
BACKOFF_BASE_SECONDS = 0.25
BACKOFF_CAP_SECONDS = 5.0


TokenSource = Callable[[], str]

__all__ = ["ApprovalRequired", "ClientSecretExchanger", "TokenSource"]


def _decode_jwt_exp(token: str) -> float | None:
    parts = token.split(".")
    if len(parts) != 3:
        return None
    payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        payload = json.loads(base64.urlsafe_b64decode(payload_b64.encode("ascii")))
    except (binascii.Error, ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    exp = payload.get("exp")
    if isinstance(exp, (int, float)):
        return float(exp)
    return None


def _transient_status(status: int) -> bool:
    return status in (408, 425, 429) or status >= 500


def _retry_delay(response: httpx.Response | None, attempt: int) -> float:
    if response is not None:
        header = response.headers.get("Retry-After")
        if header:
            try:
                seconds = float(header)
                if seconds >= 0:
                    return seconds
            except ValueError:
                try:
                    when = parsedate_to_datetime(header)
                    delta = when.timestamp() - time.time()
                    if delta > 0:
                        return delta
                except (TypeError, ValueError):
                    pass
    delay = min(BACKOFF_BASE_SECONDS * (2**attempt), BACKOFF_CAP_SECONDS)
    half = delay / 2
    return half + random.random() * half


def _leeway(exp: float, minted_at: float) -> float:
    """Refresh margin for a token: capped at MAX_LEEWAY_SECONDS but never more
    than half the token's lifetime, so short-lived tokens are still served
    from cache instead of re-minted every call."""
    return min(MAX_LEEWAY_SECONDS, max(exp - minted_at, 0.0) / 2)


class ClientSecretExchanger:
    """Exchanges an application client_secret for STS tokens via RFC 8693
    token exchange: a lifecycle access token for the application itself, and
    per-agent resource mandates bound to an agent session and delegation edge.
    Every result is cached and refreshed on demand as it approaches its `exp`
    claim; transient STS failures are retried with jittered backoff inside a
    per-exchange deadline."""

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
        retries: int = DEFAULT_RETRIES,
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
        self._retries = retries
        self._lock = threading.Lock()
        self._token_lock = threading.Lock()
        self._token: str | None = None
        self._exp: float | None = None
        self._token_leeway = MAX_LEEWAY_SECONDS
        self._mandates: OrderedDict[
            tuple[str, frozenset[str], str | None, str | None],
            tuple[str, float, float],
        ] = OrderedDict()
        self._mandate_locks: dict[
            tuple[str, frozenset[str], str | None, str | None], threading.Lock
        ] = {}
        self._owns_http = http_client is None
        self._http = (
            http_client
            if http_client is not None
            else httpx.Client(timeout=httpx.Timeout(10.0))
        )

    def close(self) -> None:
        """Release the owned HTTP client. Idempotent; injected clients stay
        the caller's responsibility."""
        if self._owns_http:
            self._http.close()

    def _cached_lifecycle(self) -> str | None:
        with self._lock:
            if self._token is not None and self._exp is not None:
                if self._exp - time.time() > self._token_leeway:
                    return self._token
        return None

    def get_token(self) -> str:
        cached = self._cached_lifecycle()
        if cached is not None:
            return cached
        with self._token_lock:
            cached = self._cached_lifecycle()
            if cached is not None:
                return cached
            token, exp = self._exchange(
                {
                    "grant_type": GRANT_TYPE,
                    "zone_id": self._zone_id,
                    "application_id": self._application_id,
                    "client_secret": self._client_secret,
                    "scope": self._scope,
                    "resource": self._resources,
                }
            )
            with self._lock:
                self._token = token
                self._exp = exp
                self._token_leeway = _leeway(exp, time.time())
            return token

    def invalidate(self) -> None:
        """Drop the cached lifecycle token and every cached mandate so the
        next call exchanges fresh ones. Called when a verifier rejects a token
        before its `exp`, e.g. after server-side session revocation."""
        with self._lock:
            self._token = None
            self._exp = None
            self._mandates.clear()

    def _mandate_lock(
        self, key: tuple[str, frozenset[str], str | None, str | None]
    ) -> threading.Lock:
        with self._lock:
            lock = self._mandate_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._mandate_locks[key] = lock
            return lock

    def _cached_mandate(
        self, key: tuple[str, frozenset[str], str | None, str | None]
    ) -> str | None:
        with self._lock:
            cached = self._mandates.get(key)
            if cached is not None and cached[1] - time.time() > cached[2]:
                self._mandates.move_to_end(key)
                return cached[0]
        return None

    def _store_mandate(
        self,
        key: tuple[str, frozenset[str], str | None, str | None],
        token: str,
        exp: float,
    ) -> None:
        with self._lock:
            self._mandates[key] = (token, exp, _leeway(exp, time.time()))
            self._mandates.move_to_end(key)
            if len(self._mandates) > MANDATE_CACHE_CAP:
                now = time.time()
                expired = [k for k, v in self._mandates.items() if v[1] <= now]
                for k in expired:
                    del self._mandates[k]
                while len(self._mandates) > MANDATE_CACHE_CAP:
                    evicted, _ = self._mandates.popitem(last=False)
                    self._mandate_locks.pop(evicted, None)

    def mint_mandate(
        self,
        *,
        resource: str,
        scopes: list[str],
        agent_session_id: str | None = None,
        delegation_edge_id: str | None = None,
        ttl_seconds: int | None = None,
        approval_id: str | None = None,
    ) -> str:
        """Exchange the application credential for a resource mandate audienced
        to one resource and narrowed to the requested scopes. Pass the calling
        agent's session and delegation edge so the STS evaluates policy against
        that agent's authority and the mandate carries its identity. When a scope
        is approval-gated the mint raises :class:`ApprovalRequired`; retry with
        ``approval_id`` set to the returned challenge id once an approver has
        satisfied it."""
        if not resource:
            raise ValueError("mint_mandate requires a resource")
        if not scopes:
            raise ValueError("mint_mandate requires at least one scope")
        scope_set = frozenset(scopes)
        key = (resource, scope_set, agent_session_id, delegation_edge_id)
        cached = self._cached_mandate(key)
        if cached is not None:
            return cached
        with self._mandate_lock(key):
            cached = self._cached_mandate(key)
            if cached is not None:
                return cached
            data: dict[str, str | list[str]] = {
                "grant_type": GRANT_TYPE,
                "zone_id": self._zone_id,
                "application_id": self._application_id,
                "client_secret": self._client_secret,
                "scope": " ".join(sorted(scope_set)),
                "resource": resource,
            }
            if agent_session_id:
                data["agent_session_id"] = agent_session_id
            if delegation_edge_id:
                data["delegation_edge_id"] = delegation_edge_id
            if ttl_seconds is not None:
                data["ttl_seconds"] = str(ttl_seconds)
            if approval_id:
                data["challenge_id"] = approval_id
            token, exp = self._exchange(data)
            self._store_mandate(key, token, exp)
            return token

    def wait_for_approval(
        self, challenge_id: str, *, timeout_seconds: float = 300.0
    ) -> str:
        """Long-poll the approval challenge until an approver decides it, it
        expires, or the timeout elapses. Returns the final lifecycle state:
        ``approved`` means a retry of ``mint_mandate`` with ``approval_id`` will
        mint; ``rejected`` and ``expired`` are terminal; ``pending`` means the
        timeout elapsed with no decision and waiting again is safe."""
        if not challenge_id:
            raise ValueError("wait_for_approval requires a challenge_id")
        deadline = time.time() + timeout_seconds
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return "pending"
            wait = max(1, min(25, int(remaining)))
            url = f"{self._sts_url}/step-up/{challenge_id}?wait={wait}"
            resp = self._http.get(url, timeout=wait + 10.0)
            resp.raise_for_status()
            state = str(resp.json().get("state", ""))
            if state and state != "pending":
                return state

    def _exchange(self, data: dict[str, str | list[str]]) -> tuple[str, float]:
        url = f"{self._sts_url}/oauth/2/token"
        deadline = time.time() + self._timeout
        attempt = 0
        while True:
            response: httpx.Response | None = None
            try:
                response = self._http.post(url, data=data)
            except httpx.TransportError:
                if attempt >= self._retries or time.time() >= deadline:
                    raise
            if response is not None:
                if response.is_success:
                    return self._parse_token(response)
                if (
                    not _transient_status(response.status_code)
                    or attempt >= self._retries
                ):
                    raise_for_caracal_error(response)
            remaining = deadline - time.time()
            if remaining <= 0:
                if response is not None:
                    raise_for_caracal_error(response)
                raise TimeoutError("STS token exchange timed out")
            time.sleep(min(_retry_delay(response, attempt), remaining))
            attempt += 1

    def _parse_token(self, response: httpx.Response) -> tuple[str, float]:
        body = response.json()
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
