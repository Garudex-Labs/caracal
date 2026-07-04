"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

RFC 8693 token exchange client with cache isolation and bounded retries.
"""

from __future__ import annotations

import asyncio
import hmac
import secrets
from hashlib import sha256
from time import time
from typing import Any

import httpx

from .cache import InMemoryTokenCache, TokenCache
from .types import ExchangeOptions, InteractionRequiredError, TokenExchangeResponse


class OAuthClient:
    def __init__(
        self,
        sts_url: str,
        zone_id: str,
        application_id: str,
        cache: TokenCache | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._sts_url = sts_url.rstrip("/")
        self._zone_id = zone_id
        self._application_id = application_id
        self._cache = cache or InMemoryTokenCache()
        self._http_client = http_client or httpx.AsyncClient()
        self._owns_client = http_client is None
        self._inflight: dict[str, asyncio.Task[TokenExchangeResponse]] = {}

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http_client.aclose()

    async def exchange(
        self,
        subject_token: str,
        resource: str,
        opts: ExchangeOptions | None = None,
    ) -> TokenExchangeResponse:
        opts = opts or ExchangeOptions()
        timeout_ms = opts.timeout_ms
        preflight_window = timeout_ms / 1000 + 30
        cache_subject = self._cache_subject(subject_token, opts)
        cache_resource = self._cache_resource(resource, opts)
        cached = self._cache.get(cache_subject, cache_resource)
        if cached is not None and cached.issued_at + cached.expires_in - time() > preflight_window:
            return cached

        inflight_key = f"{cache_subject}::{cache_resource}"
        task = self._inflight.get(inflight_key)
        if task is not None:
            return await task

        task = asyncio.create_task(self._exchange_and_cache(subject_token, resource, opts, cache_subject, cache_resource))
        self._inflight[inflight_key] = task
        try:
            return await task
        finally:
            self._inflight.pop(inflight_key, None)

    async def _exchange_and_cache(
        self,
        subject_token: str,
        resource: str,
        opts: ExchangeOptions,
        cache_subject: str,
        cache_resource: str,
    ) -> TokenExchangeResponse:
        token = await self._do_exchange(subject_token, resource, opts, False, time() + opts.timeout_ms / 1000)
        self._cache.set(cache_subject, cache_resource, token)
        return token

    def _cache_subject(self, subject_token: str, opts: ExchangeOptions) -> str:
        return "::".join(
            [
                f"{self._zone_id}::{self._application_id}",
                _hash_secret(subject_token),
                _hash_secret(opts.actor_token),
                opts.session_id or "",
                opts.agent_session_id or "",
                opts.delegation_edge_id or "",
                self._auth_context(opts),
                _hash_secret(opts.client_assertion),
            ]
        )

    def _cache_resource(self, resource: str, opts: ExchangeOptions) -> str:
        return "::".join([resource, _normalized_scopes(opts.scopes), str(opts.ttl_seconds or "")])

    def _auth_context(self, opts: ExchangeOptions) -> str:
        secret = f"secret:{_hash_secret(opts.client_secret)}" if opts.client_secret else ""
        assertion = "assertion" if opts.client_assertion else ""
        return ":".join([secret, assertion, opts.client_assertion_type or ""])

    async def _do_exchange(
        self,
        subject_token: str,
        resource: str,
        opts: ExchangeOptions,
        is_retry: bool,
        deadline: float,
    ) -> TokenExchangeResponse:
        data = {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": subject_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:access_token",
            "resource": resource,
            "zone_id": self._zone_id,
            "application_id": self._application_id,
        }
        _set_value(data, "client_secret", opts.client_secret)
        _set_value(data, "client_assertion", opts.client_assertion)
        _set_value(data, "client_assertion_type", opts.client_assertion_type)
        _set_value(data, "actor_token", opts.actor_token)
        _set_value(data, "session_id", opts.session_id)
        _set_value(data, "agent_session_id", opts.agent_session_id)
        _set_value(data, "delegation_edge_id", opts.delegation_edge_id)
        scope = _normalized_scopes(opts.scopes)
        if scope:
            data["scope"] = scope
        if opts.ttl_seconds is not None:
            data["ttl_seconds"] = str(opts.ttl_seconds)

        response: httpx.Response | None = None
        for attempt in range(opts.retries + 1):
            remaining = deadline - time()
            if remaining <= 0:
                raise TimeoutError("STS request timed out")
            try:
                response = await self._http_client.post(
                    f"{self._sts_url}/oauth/2/token",
                    data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    timeout=remaining,
                )
            except httpx.HTTPError:
                if attempt == opts.retries:
                    raise
                await _sleep_within_deadline(_backoff(attempt), deadline)
                continue
            if not _transient(response.status_code) or attempt == opts.retries:
                break
            await _sleep_within_deadline(_retry_delay(response, attempt), deadline)

        if response is None:
            raise RuntimeError("STS request failed: no response")
        if not response.is_success:
            body = _read_error_response(response)
            if body.get("error") == "interaction_required":
                raise InteractionRequiredError(
                    str(body.get("error_description") or "Step-up required"),
                    str(body.get("challenge_id") or ""),
                    resource,
                    str(body["acr_values"]) if "acr_values" in body else None,
                )
            if response.status_code == 401 and not is_retry:
                return await self._do_exchange(
                    subject_token,
                    resource,
                    ExchangeOptions(
                        client_secret=opts.client_secret,
                        client_assertion=opts.client_assertion,
                        client_assertion_type=opts.client_assertion_type,
                        actor_token=opts.actor_token,
                        session_id=opts.session_id,
                        agent_session_id=opts.agent_session_id,
                        delegation_edge_id=opts.delegation_edge_id,
                        scopes=opts.scopes,
                        timeout_ms=opts.timeout_ms,
                        retries=0,
                        ttl_seconds=opts.ttl_seconds,
                    ),
                    True,
                    deadline,
                )
            raise RuntimeError(str(body.get("error_description") or f"STS error {response.status_code}"))

        if not _json_response(response.headers.get("content-type")):
            raise RuntimeError("STS response invalid: expected application/json")
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("STS response invalid: expected JSON object")
        return _validate_success(payload)


def _read_error_response(response: httpx.Response) -> dict[str, Any]:
    if not response.content:
        return {}
    payload = response.json()
    if not isinstance(payload, dict):
        raise RuntimeError(f"STS error {response.status_code}: invalid error response")
    return payload


def _validate_success(payload: dict[str, Any]) -> TokenExchangeResponse:
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or access_token == "":
        raise RuntimeError("STS response invalid: access_token is required")
    token_type = payload.get("token_type")
    if token_type is not None and token_type != "Bearer":
        raise RuntimeError("STS response invalid: token_type must be Bearer")
    expires_in = payload.get("expires_in")
    if isinstance(expires_in, bool) or not isinstance(expires_in, int) or expires_in <= 0:
        raise RuntimeError("STS response invalid: expires_in must be a positive integer")
    return TokenExchangeResponse(access_token=access_token, token_type="Bearer", expires_in=expires_in, issued_at=int(time()))


def _set_value(data: dict[str, str], name: str, value: str | None) -> None:
    if value:
        data[name] = value


def _normalized_scopes(scopes: list[str]) -> str:
    return " ".join(sorted(set(scopes)))


def _transient(status: int) -> bool:
    return status in (408, 425, 429) or 500 <= status < 600


def _retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("retry-after")
    if retry_after:
        try:
            return max(0, float(retry_after))
        except ValueError:
            pass
    return _backoff(attempt)


def _backoff(attempt: int) -> float:
    return min((2**attempt) * 0.25, 5)


async def _sleep_within_deadline(delay: float, deadline: float) -> None:
    remaining = deadline - time()
    if remaining <= 0:
        raise TimeoutError("STS request timed out")
    await asyncio.sleep(min(delay, remaining))


def _json_response(content_type: str | None) -> bool:
    if content_type is None:
        return True
    media_type = content_type.lower().split(";", 1)[0]
    return media_type == "application/json" or media_type.endswith("+json")


def _hash_secret(value: str | None) -> str:
    if not value:
        return ""
    # Keyed per process so cache keys cannot serve as an offline-crackable
    # digest of the credential.
    return hmac.new(_CACHE_KEY_SECRET, value.encode(), sha256).hexdigest()


_CACHE_KEY_SECRET = secrets.token_bytes(32)
