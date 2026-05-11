"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

REST transport: synchronous httpx client with auth, idempotency keys,
deadlines, and retry hooks; supports submit-and-poll for async-job providers.
"""
from __future__ import annotations

import os
import time
from dataclasses import dataclass

import httpx

from app.services.resilience import (
    CircuitOpenError, RetryPolicy, breaker, idempotency_key, with_retry,
)


class TransportError(RuntimeError):
    def __init__(self, status: int, body: dict, *, retry_after_s: float | None = None):
        super().__init__(f"http {status}: {body}")
        self.status = status
        self.body = body
        self.retry_after_s = retry_after_s


_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (httpx.ConnectError, httpx.ReadTimeout, httpx.WriteTimeout, httpx.RemoteProtocolError)):
        return True
    if isinstance(exc, TransportError):
        return exc.status in _RETRYABLE_STATUS
    if isinstance(exc, CircuitOpenError):
        return False
    return False


@dataclass(frozen=True)
class AuthSpec:
    header: str
    prefix: str = ""
    env: str = ""

    def apply(self, headers: dict[str, str]) -> dict[str, str]:
        token = os.getenv(self.env, "") if self.env else ""
        if token:
            headers[self.header] = f"{self.prefix}{token}"
        return headers


@dataclass(frozen=True)
class RestEndpoint:
    method: str
    path: str
    idempotent_write: bool = False


class RestClient:
    """One client per provider; reuses an httpx connection pool."""

    def __init__(
        self,
        provider: str,
        base_url: str,
        auth: AuthSpec,
        *,
        timeout_s: float = 5.0,
        policy: RetryPolicy = RetryPolicy(),
        transport: httpx.BaseTransport | None = None,
    ):
        self.provider = provider
        self._auth = auth
        self._policy = policy
        self._breaker = breaker(provider)
        self._http = httpx.Client(
            base_url=base_url,
            timeout=timeout_s,
            transport=transport,
            headers={"User-Agent": f"lynxcapital/{provider}"},
        )

    def close(self) -> None:
        self._http.close()

    def _do(self, method: str, path: str, *, json: dict | None,
            headers: dict[str, str], attempt: int) -> httpx.Response:
        h = dict(headers)
        h["X-Attempt"] = str(attempt)
        self._auth.apply(h)
        return self._http.request(method, path, json=json, headers=h)

    def call(self, endpoint: RestEndpoint, payload: dict, *,
             idem_key: str | None = None) -> dict:
        headers: dict[str, str] = {}
        if endpoint.idempotent_write:
            headers["Idempotency-Key"] = idem_key or idempotency_key(self.provider)

        def _attempt(attempt: int) -> dict:
            body = payload if endpoint.method.upper() != "GET" else None
            r = self._do(endpoint.method, endpoint.path,
                         json=body, headers=headers, attempt=attempt)
            if r.status_code >= 400:
                try:
                    err = r.json()
                except Exception:
                    err = {"error": r.text}
                retry_after = r.headers.get("retry-after")
                raise TransportError(r.status_code, err,
                                     retry_after_s=float(retry_after) if retry_after else None)
            return r.json() if r.content else {}

        return with_retry(self.provider, _attempt,
                          policy=self._policy, is_retryable=_is_retryable,
                          breaker_obj=self._breaker)

    def submit_and_wait(
        self,
        endpoint: RestEndpoint,
        payload: dict,
        *,
        poll_path: str,
        deadline_s: float = 30.0,
        poll_interval_s: float = 0.25,
        idem_key: str | None = None,
    ) -> dict:
        """Submit an async-job request and poll until completed/failed or deadline."""
        ack = self.call(endpoint, payload, idem_key=idem_key)
        job_id = ack.get("job_id")
        if not job_id:
            return ack
        deadline = time.monotonic() + deadline_s
        fast = os.getenv("LYNX_MOCK_FAST") == "1"
        interval = 0.02 if fast else poll_interval_s
        while True:
            status = self.call(RestEndpoint("GET", f"{poll_path}/{job_id}"), {})
            state = status.get("status")
            if state == "completed":
                return status.get("result") or status
            if state == "failed":
                raise TransportError(500, status)
            if time.monotonic() > deadline:
                raise TransportError(504, {"error": "job poll deadline exceeded", "job_id": job_id})
            time.sleep(interval)
