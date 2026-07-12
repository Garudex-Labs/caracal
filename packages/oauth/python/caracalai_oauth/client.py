"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

RFC 8693 token exchange client with cache isolation.
"""

from __future__ import annotations

import asyncio
import hmac
import secrets
from hashlib import sha256
from time import time
from typing import Any
from urllib.parse import quote

import httpx

from .cache import InMemoryTokenCache, TokenCache
from .errors import ApprovalRequired, CaracalError, raise_for_caracal_error
from .events import CaracalEvent, EventHook, emit_event
from .types import ExchangeOptions, TokenExchangeResponse


class OAuthClient:
    def __init__(
        self,
        sts_url: str,
        zone_id: str,
        application_id: str,
        cache: TokenCache | None = None,
        http_client: httpx.AsyncClient | None = None,
        on_event: EventHook | None = None,
    ) -> None:
        self._sts_url = sts_url.rstrip("/")
        self._zone_id = zone_id
        self._application_id = application_id
        self._cache = cache or InMemoryTokenCache()
        self._http_client = http_client or httpx.AsyncClient()
        self._owns_client = http_client is None
        self._inflight: dict[str, asyncio.Task[TokenExchangeResponse]] = {}
        self._on_event = on_event

    async def aclose(self) -> None:
        if self._owns_client:
            await self._http_client.aclose()

    async def federate_subject(
        self,
        id_token: str,
        *,
        client_secret: str | None = None,
        ttl_seconds: int | None = None,
        timeout_ms: int = 30_000,
    ) -> TokenExchangeResponse:
        """Exchange an end user's identity token from a zone-trusted external
        issuer for a Caracal Subject authority record.

        The application authenticates itself with its client secret and relays
        the token verbatim; the minted record is the Subject's identity anchor
        and carries no resource authority. Never cached: each federation is an
        explicit identity event.
        """
        if not id_token:
            raise ValueError("federate_subject requires the end user identity token")
        data = {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "subject_token": id_token,
            "subject_token_type": "urn:ietf:params:oauth:token-type:id_token",
            "zone_id": self._zone_id,
            "application_id": self._application_id,
        }
        _set_value(data, "client_secret", client_secret)
        if ttl_seconds is not None:
            data["ttl_seconds"] = str(ttl_seconds)
        response = await self._http_client.post(
            f"{self._sts_url}/oauth/2/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=timeout_ms / 1000,
        )
        if not response.is_success:
            raise_for_caracal_error(response)
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("STS response invalid: expected JSON object")
        return _validate_success(payload)

    async def decide_approval(
        self,
        *,
        subject_token: str,
        approval_id: str,
        binding: str,
        decision: str,
        reason: str | None = None,
        timeout_ms: int = 30_000,
    ) -> None:
        """Post an end user's decision on a subject-reserved approval hold.

        The subject token is the user's federated session mandate, and the
        binding must echo the hold exactly - a prompt that does not know the
        held resource and scope set cannot decide it.
        """
        if not subject_token or not approval_id or not binding:
            raise ValueError(
                "decide_approval requires subject_token, approval_id, and binding"
            )
        body: dict[str, str] = {"decision": decision, "binding": binding}
        if reason:
            body["reason"] = reason
        response = await self._http_client.post(
            f"{self._sts_url}/step-up/{quote(approval_id, safe='')}/decision",
            json=body,
            headers={"Authorization": f"Bearer {subject_token}"},
            timeout=timeout_ms / 1000,
        )
        if not response.is_success:
            raise_for_caracal_error(response)

    async def exchange(
        self,
        subject_token: str,
        resource: str | list[str],
        opts: ExchangeOptions | None = None,
    ) -> TokenExchangeResponse:
        opts = opts or ExchangeOptions()
        resources = _resource_list(resource)
        scopes = tuple(sorted(set(opts.scopes)))
        started_at = time()
        timeout_ms = opts.timeout_ms
        if timeout_ms <= 0:
            raise TimeoutError("STS request timed out")
        preflight_window = timeout_ms / 1000 + 30
        cache_subject = self._cache_subject(subject_token, opts)
        cache_resource = self._cache_resource(resources, opts)
        one_shot = opts.one_shot or not opts.cache or bool(opts.challenge_id)
        cached = (
            self._cache.get(cache_subject, cache_resource)
            if not one_shot and not opts.force_refresh
            else None
        )
        if (
            cached is not None
            and cached.issued_at + cached.expires_in - time() > preflight_window
        ):
            emit_event(
                self._on_event,
                CaracalEvent(
                    type="token.exchange",
                    ok=True,
                    resources=tuple(resources),
                    scopes=scopes,
                    cached=True,
                ),
            )
            return cached

        if one_shot:
            try:
                token = await self._do_exchange(subject_token, resources, opts)
            except Exception as err:
                emit_event(
                    self._on_event,
                    _exchange_event(False, resources, scopes, started_at, err),
                )
                raise
            emit_event(
                self._on_event,
                _exchange_event(True, resources, scopes, started_at),
            )
            return token

        inflight_key = f"{cache_subject}::{cache_resource}"
        task = self._inflight.get(inflight_key)
        if task is not None:
            return await asyncio.shield(task)

        task = asyncio.create_task(
            self._exchange_and_cache(
                subject_token, resources, opts, cache_subject, cache_resource
            )
        )
        self._inflight[inflight_key] = task
        try:
            return await asyncio.shield(task)
        finally:
            self._inflight.pop(inflight_key, None)

    async def _exchange_and_cache(
        self,
        subject_token: str,
        resources: list[str],
        opts: ExchangeOptions,
        cache_subject: str,
        cache_resource: str,
    ) -> TokenExchangeResponse:
        scopes = tuple(sorted(set(opts.scopes)))
        started_at = time()
        try:
            token = await self._do_exchange(subject_token, resources, opts)
        except Exception as err:
            emit_event(
                self._on_event,
                _exchange_event(False, resources, scopes, started_at, err),
            )
            raise
        self._cache.set(cache_subject, cache_resource, token)
        emit_event(
            self._on_event,
            _exchange_event(True, resources, scopes, started_at),
        )
        return token

    def _cache_subject(self, subject_token: str, opts: ExchangeOptions) -> str:
        return "::".join(
            [
                f"{self._zone_id}::{self._application_id}",
                _hash_secret(subject_token),
                opts.authority_record_id or "",
                opts.session_id or "",
                opts.delegation_id or "",
                self._auth_context(opts),
            ]
        )

    def _cache_resource(self, resources: list[str], opts: ExchangeOptions) -> str:
        return "::".join(
            [
                " ".join(resources),
                _normalized_scopes(opts.scopes),
                str(opts.ttl_seconds or ""),
            ]
        )

    def _auth_context(self, opts: ExchangeOptions) -> str:
        secret = (
            f"secret:{_hash_secret(opts.client_secret)}" if opts.client_secret else ""
        )
        return secret

    async def _do_exchange(
        self,
        subject_token: str,
        resources: list[str],
        opts: ExchangeOptions,
    ) -> TokenExchangeResponse:
        data: dict[str, Any] = {
            "grant_type": "urn:ietf:params:oauth:grant-type:token-exchange",
            "resource": resources,
            "zone_id": self._zone_id,
            "application_id": self._application_id,
        }
        if subject_token:
            data["subject_token"] = subject_token
            data["subject_token_type"] = "urn:ietf:params:oauth:token-type:access_token"
        _set_value(data, "client_secret", opts.client_secret)
        _set_value(data, "session_id", opts.authority_record_id)
        _set_value(data, "agent_session_id", opts.session_id)
        _set_value(data, "delegation_edge_id", opts.delegation_id)
        _set_value(data, "challenge_id", opts.challenge_id)
        scope = _normalized_scopes(opts.scopes)
        if scope:
            data["scope"] = scope
        if opts.ttl_seconds is not None:
            data["ttl_seconds"] = str(opts.ttl_seconds)

        response = await self._http_client.post(
            f"{self._sts_url}/oauth/2/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            timeout=opts.timeout_ms / 1000,
        )
        if not response.is_success:
            try:
                raise_for_caracal_error(response)
            except ApprovalRequired as err:
                err.resource = resources[0] if resources else ""
                raise

        if not _json_response(response.headers.get("content-type")):
            raise RuntimeError("STS response invalid: expected application/json")
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("STS response invalid: expected JSON object")
        return _validate_success(payload)


def _validate_success(payload: dict[str, Any]) -> TokenExchangeResponse:
    access_token = payload.get("access_token")
    if not isinstance(access_token, str) or access_token == "":
        raise RuntimeError("STS response invalid: access_token is required")
    token_type = payload.get("token_type")
    if token_type is not None and token_type != "Bearer":
        raise RuntimeError("STS response invalid: token_type must be Bearer")
    expires_in = payload.get("expires_in")
    if (
        isinstance(expires_in, bool)
        or not isinstance(expires_in, int)
        or expires_in <= 0
    ):
        raise RuntimeError(
            "STS response invalid: expires_in must be a positive integer"
        )
    return TokenExchangeResponse(
        access_token=access_token,
        token_type="Bearer",
        expires_in=expires_in,
        issued_at=int(time()),
        target_resources=_target_resources(payload),
    )


def _set_value(data: dict[str, Any], name: str, value: str | None) -> None:
    if value:
        data[name] = value


def _normalized_scopes(scopes: list[str]) -> str:
    return " ".join(sorted(set(scopes)))


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


def _resource_list(resource: str | list[str]) -> list[str]:
    values = [resource] if isinstance(resource, str) else resource
    return sorted({value.strip() for value in values if value.strip()})


def _target_resources(payload: dict[str, Any]) -> tuple[str, ...]:
    value = payload.get("target_resources")
    if value is None:
        return ()
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise RuntimeError(
            "STS response invalid: target_resources must be a string array"
        )
    return tuple(value)


def _exchange_event(
    ok: bool,
    resources: list[str],
    scopes: tuple[str, ...],
    started_at: float,
    err: Exception | None = None,
) -> CaracalEvent:
    return CaracalEvent(
        type="token.exchange",
        ok=ok,
        duration_ms=(time() - started_at) * 1000,
        resources=tuple(resources),
        scopes=scopes,
        status=err.http_status if isinstance(err, CaracalError) else 0,
        code=err.code if isinstance(err, CaracalError) else "",
    )
