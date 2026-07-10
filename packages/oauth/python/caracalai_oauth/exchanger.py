"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Token-exchange client that turns an application client_secret into STS access tokens and resource mandates, refreshing each before expiry.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import random
import secrets
import threading
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

import httpx

from .errors import (
    ApprovalRequired,
    CredentialsUnavailableError,
    raise_for_caracal_error,
)
from .events import CaracalEvent, EventHook, emit_event
from .types import APPROVAL_STATES, ApprovalState, MintedMandate

GRANT_TYPE = "urn:ietf:params:oauth:grant-type:token-exchange"
MAX_LEEWAY_SECONDS = 60.0
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_RETRIES = 3
MANDATE_CACHE_CAP = 10_000
BACKOFF_BASE_SECONDS = 0.25
BACKOFF_CAP_SECONDS = 5.0
_CREDENTIAL_KEY = secrets.token_bytes(32)


TokenSource = Callable[[], str]


@dataclass(frozen=True)
class ClientCredentials:
    """The application credential triple a resolver returns."""

    zone_id: str
    application_id: str
    client_secret: str


CredentialsResolver = Callable[[], "ClientCredentials | None"]

_MandateKey = tuple[str, str, str, frozenset[str], str | None, str | None, int | None]

__all__ = [
    "ApprovalRequired",
    "ClientCredentials",
    "ClientSecretExchanger",
    "CredentialsResolver",
    "CredentialsUnavailableError",
    "TokenSource",
    "decode_jwt_exp",
]


def decode_jwt_payload(token: str) -> dict[str, object] | None:
    """The decoded payload of a JWT-shaped token, or ``None`` when the token
    is opaque or malformed. Signature verification is the verifier's
    responsibility."""
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
    return payload


def decode_jwt_exp(token: str) -> float | None:
    """The ``exp`` claim of a JWT-shaped token, or ``None`` when the token is
    opaque or the claim is absent or malformed. Signature verification is the
    verifier's responsibility."""
    payload = decode_jwt_payload(token)
    if payload is None:
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
    resource mandates bound to a Session and Delegation.
    Credentials come from a resolver invoked per exchange, so rotation and
    identity swaps take effect without rebuilding the client; every cached
    result is keyed to the identity that minted it. Results are refreshed on
    demand as they approach their `exp` claim; transient STS failures are
    retried with jittered backoff inside a per-exchange deadline.

    Integrators never construct one: ``from_client_secret`` (and profile or
    environment detection) wires it into the client; the class is public so
    the credential surface can be observed and faked in tests."""

    def __init__(
        self,
        *,
        sts_url: str,
        credentials: CredentialsResolver,
        resources: list[str],
        scope: str = "agent:lifecycle",
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        retries: int = DEFAULT_RETRIES,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._sts_url = sts_url.rstrip("/")
        self._credentials = credentials
        self._resources = list(resources)
        self._scope = scope
        self._timeout = timeout_seconds
        self._retries = retries
        self._lock = threading.Lock()
        self._token_lock = threading.Lock()
        self._token: str | None = None
        self._exp: float | None = None
        self._token_identity: tuple[str, str] | None = None
        self._credential_fingerprint: bytes | None = None
        self._token_leeway = MAX_LEEWAY_SECONDS
        self._mandates: OrderedDict[_MandateKey, tuple[str, float, float]] = (
            OrderedDict()
        )
        self._mandate_locks: dict[_MandateKey, tuple[threading.Lock, int]] = {}
        self._owns_http = http_client is None
        self._http = (
            http_client
            if http_client is not None
            else httpx.Client(timeout=httpx.Timeout(10.0))
        )
        self._async_http: httpx.AsyncClient | None = None
        self.on_event: EventHook | None = None

    def _resolve(self) -> ClientCredentials:
        creds = self._credentials()
        if creds is None or not (
            creds.zone_id and creds.application_id and creds.client_secret
        ):
            raise CredentialsUnavailableError()
        fingerprint = hmac.digest(
            _CREDENTIAL_KEY, creds.client_secret.encode(), "sha256"
        )
        with self._lock:
            if self._credential_fingerprint is not None and not hmac.compare_digest(
                self._credential_fingerprint, fingerprint
            ):
                self._token = None
                self._exp = None
                self._token_identity = None
                self._mandates.clear()
                self._mandate_locks = {
                    key: record
                    for key, record in self._mandate_locks.items()
                    if record[1]
                }
            self._credential_fingerprint = fingerprint
        return creds

    def identity(self) -> tuple[str, str]:
        """The (zone_id, application_id) pair the resolver currently yields;
        fails closed when no usable credential is available."""
        creds = self._resolve()
        return (creds.zone_id, creds.application_id)

    def credential_generation(self) -> str:
        """Opaque process-local generation for credential-derived cache keys."""
        self._resolve()
        with self._lock:
            return (self._credential_fingerprint or b"").hex()

    def close(self) -> None:
        """Release the owned HTTP client. Idempotent; injected clients stay
        the caller's responsibility."""
        if self._owns_http:
            self._http.close()

    async def aclose(self) -> None:
        """Release every owned HTTP pool; injected clients remain caller-owned."""
        await asyncio.to_thread(self.close)
        if self._async_http is not None:
            await self._async_http.aclose()
            self._async_http = None

    def _cached_lifecycle(self, identity: tuple[str, str]) -> str | None:
        with self._lock:
            token = None
            if (
                self._token is not None
                and self._exp is not None
                and self._token_identity == identity
            ):
                if self._exp - time.time() > self._token_leeway:
                    token = self._token
        if token is not None:
            emit_event(
                self.on_event,
                CaracalEvent(
                    type="token.exchange",
                    ok=True,
                    cached=True,
                    resources=tuple(self._resources),
                    scopes=(self._scope,),
                ),
            )
        return token

    def get_token(self) -> str:
        creds = self._resolve()
        if not self._resources:
            raise RuntimeError(
                "Caracal: this client has no resources configured; Session and "
                "lifecycle paths require at least one"
            )
        identity = (creds.zone_id, creds.application_id)
        cached = self._cached_lifecycle(identity)
        if cached is not None:
            return cached
        with self._token_lock:
            cached = self._cached_lifecycle(identity)
            if cached is not None:
                return cached
            token, exp = self._exchange(
                {
                    "grant_type": GRANT_TYPE,
                    "zone_id": creds.zone_id,
                    "application_id": creds.application_id,
                    "client_secret": creds.client_secret,
                    "scope": self._scope,
                    "resource": self._resources,
                }
            )
            with self._lock:
                self._token = token
                self._exp = exp
                self._token_identity = identity
                self._token_leeway = _leeway(exp, time.time())
            return token

    def invalidate(self) -> None:
        """Drop the cached lifecycle token and every cached mandate so the
        next call exchanges fresh ones. Called when a verifier rejects a token
        before its `exp`, e.g. after server-side session revocation."""
        with self._lock:
            self._token = None
            self._exp = None
            self._token_identity = None
            self._mandates.clear()
            self._mandate_locks = {
                key: record for key, record in self._mandate_locks.items() if record[1]
            }

    def _mandate_lock(self, key: _MandateKey) -> threading.Lock:
        with self._lock:
            record = self._mandate_locks.get(key)
            lock = record[0] if record is not None else threading.Lock()
            self._mandate_locks[key] = (lock, (record[1] if record else 0) + 1)
            return lock

    def _release_mandate_lock(self, key: _MandateKey, lock: threading.Lock) -> None:
        with self._lock:
            record = self._mandate_locks.get(key)
            if record is None or record[0] is not lock:
                return
            if record[1] == 1:
                del self._mandate_locks[key]
            else:
                self._mandate_locks[key] = (lock, record[1] - 1)

    def _cached_mandate(self, key: _MandateKey) -> MintedMandate | None:
        minted = None
        with self._lock:
            cached = self._mandates.get(key)
            if cached is not None and cached[1] - time.time() > cached[2]:
                self._mandates.move_to_end(key)
                minted = MintedMandate(
                    token=cached[0],
                    expires_in_seconds=max(0, int(cached[1] - time.time())),
                )
        if minted is not None:
            emit_event(
                self.on_event,
                CaracalEvent(
                    type="token.exchange",
                    ok=True,
                    cached=True,
                    resources=(key[2],),
                    scopes=tuple(sorted(key[3])),
                ),
            )
        return minted

    def _store_mandate(self, key: _MandateKey, token: str, exp: float) -> None:
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
        session_id: str | None = None,
        delegation_id: str | None = None,
        ttl_seconds: int | None = None,
        approval_id: str | None = None,
        cache: bool = True,
    ) -> MintedMandate:
        """Exchange the application credential for a resource mandate audienced
        to one resource and narrowed to the requested scopes. Pass the calling
        Session and Delegation so the STS evaluates policy against that
        Session's authority and the mandate carries its identity. When a scope
        is approval-gated the mint raises :class:`ApprovalRequired`; retry with
        ``approval_id`` set to the returned challenge id once an approver has
        satisfied it."""
        if not resource:
            raise ValueError("mint_mandate requires a resource")
        if not scopes:
            raise ValueError("mint_mandate requires at least one scope")
        if approval_id:
            cache = False
        creds = self._resolve()
        scope_set = frozenset(scopes)
        key = (
            creds.zone_id,
            creds.application_id,
            resource,
            scope_set,
            session_id,
            delegation_id,
            ttl_seconds,
        )
        cached = self._cached_mandate(key) if cache else None
        if cached is not None:
            return cached
        if not cache:
            data = self._mandate_data(
                creds,
                resource,
                scope_set,
                session_id,
                delegation_id,
                ttl_seconds,
                approval_id,
            )
            token, exp = self._exchange(data)
            return MintedMandate(
                token=token, expires_in_seconds=max(0, int(exp - time.time()))
            )
        lock = self._mandate_lock(key)
        try:
            with lock:
                cached = self._cached_mandate(key)
                if cached is not None:
                    return cached
                data = self._mandate_data(
                    creds,
                    resource,
                    scope_set,
                    session_id,
                    delegation_id,
                    ttl_seconds,
                    approval_id,
                )
                token, exp = self._exchange(data)
                self._store_mandate(key, token, exp)
                return MintedMandate(
                    token=token, expires_in_seconds=max(0, int(exp - time.time()))
                )
        finally:
            self._release_mandate_lock(key, lock)

    def _mandate_data(
        self,
        creds: ClientCredentials,
        resource: str,
        scopes: frozenset[str],
        session_id: str | None,
        delegation_id: str | None,
        ttl_seconds: int | None,
        approval_id: str | None,
    ) -> dict[str, str | list[str]]:
        data: dict[str, str | list[str]] = {
            "grant_type": GRANT_TYPE,
            "zone_id": creds.zone_id,
            "application_id": creds.application_id,
            "client_secret": creds.client_secret,
            "scope": " ".join(sorted(scopes)),
            "resource": resource,
        }
        if session_id:
            data["agent_session_id"] = session_id
        if delegation_id:
            data["delegation_edge_id"] = delegation_id
        if ttl_seconds is not None:
            data["ttl_seconds"] = str(ttl_seconds)
        if approval_id:
            data["challenge_id"] = approval_id
        return data

    async def await_approval(
        self, approval_id: str, *, timeout_seconds: float = 300.0
    ) -> ApprovalState:
        """Asynchronously long-poll an approval with cancellation propagated
        into the active HTTP request."""
        if not approval_id:
            raise ValueError("await_approval requires an approval_id")
        self._resolve()
        start = time.monotonic()
        deadline = time.monotonic() + timeout_seconds
        if self._async_http is None or self._async_http.is_closed:
            transport = getattr(self._http, "_transport", None)
            if not hasattr(transport, "handle_async_request"):
                transport = None
            self._async_http = httpx.AsyncClient(transport=transport)
        try:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    state: ApprovalState = "pending"
                    break
                wait = max(1, min(25, int(remaining)))
                response = await self._async_http.get(
                    f"{self._sts_url}/step-up/{approval_id}?wait={wait}",
                    timeout=min(remaining, wait + 10.0),
                )
                response.raise_for_status()
                value = str(response.json().get("state", ""))
                if value and value != "pending":
                    if value not in APPROVAL_STATES:
                        raise RuntimeError(
                            f"step-up status returned an unknown challenge state: {value}"
                        )
                    state = value  # type: ignore[assignment]
                    break
        except BaseException:
            emit_event(
                self.on_event,
                CaracalEvent(
                    type="approval.wait",
                    ok=False,
                    duration_ms=(time.monotonic() - start) * 1000.0,
                    approval_id=approval_id,
                    state="",
                ),
            )
            raise
        emit_event(
            self.on_event,
            CaracalEvent(
                type="approval.wait",
                ok=True,
                duration_ms=(time.monotonic() - start) * 1000.0,
                approval_id=approval_id,
                state=state,
            ),
        )
        return state

    def federate_subject(
        self, id_token: str, *, ttl_seconds: int | None = None
    ) -> MintedMandate:
        """Exchange an end user's identity token from a zone-trusted external
        issuer for the user's Caracal Subject mandate. The application
        authenticates itself with its client secret and relays the token
        verbatim; the minted authority record is the Subject's identity anchor and
        carries no resource authority. Never cached: each federation is an
        explicit identity event."""
        if not id_token:
            raise ValueError("federate_subject requires the end user identity token")
        creds = self._resolve()
        data: dict[str, str | list[str]] = {
            "grant_type": GRANT_TYPE,
            "zone_id": creds.zone_id,
            "application_id": creds.application_id,
            "client_secret": creds.client_secret,
            "subject_token": id_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
        }
        if ttl_seconds is not None:
            data["ttl_seconds"] = str(ttl_seconds)
        response = self._http.post(f"{self._sts_url}/oauth/2/token", data=data)
        if not response.is_success:
            raise_for_caracal_error(response)
        token, exp = self._parse_token(response)
        return MintedMandate(
            token=token, expires_in_seconds=max(0, int(exp - time.time()))
        )

    def wait_for_approval(
        self, approval_id: str, *, timeout_seconds: float = 300.0
    ) -> ApprovalState:
        """Long-poll the approval until an approver decides it, it
        expires, or the timeout elapses. Returns the final lifecycle state:
        ``approved`` means a retry of ``mint_mandate`` with ``approval_id`` will
        mint; ``rejected`` and ``expired`` are terminal; ``pending`` means the
        timeout elapsed with no decision and waiting again is safe."""
        if not approval_id:
            raise ValueError("wait_for_approval requires an approval_id")
        self._resolve()
        start = time.monotonic()

        def finish(state: str, ok: bool) -> str:
            emit_event(
                self.on_event,
                CaracalEvent(
                    type="approval.wait",
                    ok=ok,
                    duration_ms=(time.monotonic() - start) * 1000.0,
                    approval_id=approval_id,
                    state=state,
                ),
            )
            return state

        deadline = time.time() + timeout_seconds
        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                return finish("pending", True)
            wait = max(1, min(25, int(remaining)))
            url = f"{self._sts_url}/step-up/{approval_id}?wait={wait}"
            resp = self._http.get(url, timeout=min(remaining, wait + 10.0))
            try:
                resp.raise_for_status()
            except httpx.HTTPStatusError:
                finish("", False)
                raise
            state = str(resp.json().get("state", ""))
            if state and state != "pending":
                if state not in APPROVAL_STATES:
                    finish("", False)
                    raise RuntimeError(
                        f"step-up status returned an unknown challenge state: {state}"
                    )
                return finish(state, True)

    def _exchange(self, data: dict[str, str | list[str]]) -> tuple[str, float]:
        url = f"{self._sts_url}/oauth/2/token"
        resource = data.get("resource", [])
        resources = tuple(resource) if isinstance(resource, list) else (str(resource),)
        scopes = tuple(str(data.get("scope", "")).split())
        start = time.monotonic()
        deadline = time.time() + self._timeout
        attempt = 0
        try:
            while True:
                response: httpx.Response | None = None
                try:
                    response = self._http.post(url, data=data)
                except httpx.TransportError:
                    if attempt >= self._retries or time.time() >= deadline:
                        raise
                if response is not None:
                    if response.is_success:
                        token = self._parse_token(response)
                        emit_event(
                            self.on_event,
                            CaracalEvent(
                                type="token.exchange",
                                ok=True,
                                duration_ms=(time.monotonic() - start) * 1000.0,
                                resources=resources,
                                scopes=scopes,
                                status=response.status_code,
                            ),
                        )
                        return token
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
        except Exception as exc:
            emit_event(
                self.on_event,
                CaracalEvent(
                    type="token.exchange",
                    ok=False,
                    duration_ms=(time.monotonic() - start) * 1000.0,
                    resources=resources,
                    scopes=scopes,
                    status=int(getattr(exc, "http_status", 0) or 0),
                    code=str(getattr(exc, "code", "") or ""),
                ),
            )
            raise

    def _parse_token(self, response: httpx.Response) -> tuple[str, float]:
        body = response.json()
        token = body.get("access_token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("STS response did not contain access_token")
        exp = decode_jwt_exp(token)
        if exp is None:
            expires_in = body.get("expires_in")
            if isinstance(expires_in, (int, float)):
                exp = time.time() + float(expires_in)
            else:
                exp = time.time() + 600.0
        return token, exp
