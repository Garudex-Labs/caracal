"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK Gateway Adapter.

Provides a transport adapter that routes runtime SDK requests through the
enterprise gateway instead of calling the broker API directly.

OSS: behaves identically to the standard HTTP adapter (broker mode).
Enterprise: wraps every request with the gateway's auth headers and routes
            through CARACAL_ENTERPRISE_URL, gaining network-level enforcement.

Usage (explicit gateway execution signals from environment / config):

    from caracal_sdk.client import CaracalClient

    # GatewayAdapter uses explicit gateway execution signals when enabled
    client = CaracalClient(api_key="…")
    result = await client.tools.call(
        tool_id="provider:demo:resource:jobs:action:run",
        tool_args={"job": "sync"},
    )

Manual override:

    from caracal_sdk.gateway import GatewayAdapter
    from caracal_sdk.adapters.base import SDKRequest

    adapter = GatewayAdapter(
        gateway_endpoint="https://gw.example.com",
        gateway_api_key="gw_key",
        workspace_id="ws_123",
    )
    client = CaracalClient(adapter=adapter)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx

from caracal_sdk._compat import get_logger
from caracal_sdk.adapters.base import BaseAdapter, SDKRequest, SDKResponse
from caracal_sdk.json_types import JsonValue


DEPLOYMENT_OSS = "oss"
DEPLOYMENT_MANAGED = "managed"
DEPLOYMENT_ON_PREM = "on_prem"


def _bool_env(name: str) -> bool:
    return os.getenv(name, "").strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class GatewayFeatureFlags:
    """Runtime flags governing whether SDK requests use the gateway path."""

    gateway_enabled: bool = False
    gateway_endpoint: Optional[str] = None
    gateway_api_key: Optional[str] = None
    deployment_type: str = DEPLOYMENT_OSS
    fail_closed: bool = False

    @property
    def is_enterprise(self) -> bool:
        return self.deployment_type in (DEPLOYMENT_MANAGED, DEPLOYMENT_ON_PREM)


def get_gateway_features() -> GatewayFeatureFlags:
    """
    Resolve gateway flags from the Caracal runtime when installed; otherwise
    fall back to lightweight environment parsing (standalone SDK installs).
    """
    try:
        # Use __import__ (not importlib.import_module) so callers can rely on
        # builtins.__import__ hooks; fromlist forces loading the leaf module.
        core_gw = __import__(
            "caracal.core.gateway_features",
            globals(),
            locals(),
            ("GatewayFeatureFlags",),
            0,
        )
    except ImportError:
        pass
    else:
        core_flags = core_gw.get_gateway_features()
        return GatewayFeatureFlags(
            gateway_enabled=bool(core_flags.gateway_enabled),
            gateway_endpoint=core_flags.gateway_endpoint,
            gateway_api_key=core_flags.gateway_api_key,
            deployment_type=str(core_flags.deployment_type).strip().lower(),
            fail_closed=bool(core_flags.fail_closed),
        )

    return GatewayFeatureFlags(
        gateway_enabled=_bool_env("CARACAL_GATEWAY_ENABLED"),
        gateway_endpoint=os.getenv("CARACAL_ENTERPRISE_URL", "").strip() or None,
        gateway_api_key=os.getenv("CARACAL_GATEWAY_API_KEY", "").strip() or None,
        deployment_type=os.getenv(
            "CARACAL_GATEWAY_DEPLOYMENT_TYPE", DEPLOYMENT_OSS
        ).strip().lower(),
        fail_closed=_bool_env("CARACAL_GATEWAY_FAIL_CLOSED"),
    )

logger = get_logger(__name__)

_GW_REQUEST_TIMEOUT = 30


class GatewayAdapterError(Exception):
    """Raised when the gateway adapter encounters a non-retriable error."""


class GatewayAdapter(BaseAdapter):
    """
    Transport adapter that proxies SDK requests through the Caracal
    enterprise gateway.

    In OSS / broker mode this adapter can call the Caracal API directly only
    when an explicit broker base URL is configured.

    In enterprise mode (gateway_endpoint + api_key configured) every
    request is forwarded to the gateway, which performs:
            - Runtime authority enforcement (fail-closed)
      - Provider registry resolution
      - Per-tenant quota enforcement
      - Secret binding for upstream credentials
      - Metering event emission
    """

    # Headers injected on every outbound request
    GATEWAY_API_KEY_HEADER = "X-Gateway-Key"
    GATEWAY_WORKSPACE_HEADER = "X-Caracal-Workspace-ID"

    def __init__(
        self,
        gateway_endpoint: Optional[str] = None,
        gateway_api_key: Optional[str] = None,
        workspace_id: Optional[str] = None,
        broker_base_url: Optional[str] = None,
        timeout_seconds: int = _GW_REQUEST_TIMEOUT,
        feature_flags: Optional[GatewayFeatureFlags] = None,
    ) -> None:
        """
        Args:
            gateway_endpoint: Base URL of the enterprise gateway proxy.
                              Defaults to CARACAL_ENTERPRISE_URL env var.
            gateway_api_key: API key for gateway authentication.
                             Defaults to CARACAL_GATEWAY_API_KEY env var.
            workspace_id: Workspace identifier injected into every request.
            broker_base_url: Caracal API URL used for explicit broker-mode calls.
            timeout_seconds: HTTP request timeout.
            feature_flags: Pre-loaded feature flags (loaded from env if None).
        """
        self._flags = feature_flags or get_gateway_features()
        self._endpoint = (
            gateway_endpoint or self._flags.gateway_endpoint or ""
        ).rstrip("/")
        self._api_key = gateway_api_key or self._flags.gateway_api_key or ""
        self._workspace_id = workspace_id or ""
        self._broker_base = (broker_base_url or "").rstrip("/")
        self._timeout = timeout_seconds

        self._client: Optional[httpx.AsyncClient] = None
        self._connected = False

    # ── BaseAdapter interface ─────────────────────────────────────────────────

    @property
    def is_connected(self) -> bool:
        return self._connected

    async def send(self, request: SDKRequest) -> SDKResponse:
        """Route the request through the gateway (or direct API in OSS mode)."""
        client = self._get_client()

        if self._should_use_gateway():
            return await self._send_via_gateway(client, request)
        return await self._send_direct(client, request)

    def close(self) -> None:
        self._client = None
        self._connected = False

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _should_use_gateway(self) -> bool:
        if self._flags.is_enterprise:
            if self._flags.gateway_enabled and not self._endpoint:
                raise GatewayAdapterError(
                    "Enterprise gateway execution requires an explicit gateway endpoint."
                )
            return bool(self._flags.gateway_enabled and self._endpoint)

        return False

    def _get_client(self) -> httpx.AsyncClient:
        if not self._client:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout),
                follow_redirects=True,
            )
            self._connected = True
        return self._client

    async def _send_via_gateway(
        self, client: httpx.AsyncClient, request: SDKRequest
    ) -> SDKResponse:
        """Forward request to the enterprise gateway proxy."""
        url = f"{self._endpoint}{request.path}"

        headers = dict(request.headers)
        # Inject gateway auth headers
        if self._api_key:
            headers[self.GATEWAY_API_KEY_HEADER] = self._api_key
        if self._workspace_id:
            headers[self.GATEWAY_WORKSPACE_HEADER] = self._workspace_id

        # Signal to gateway that this is an SDK call (not a direct principal forward)
        headers["X-Caracal-SDK-Call"] = "1"
        headers["X-Caracal-Deployment"] = self._flags.deployment_type

        start = time.monotonic()
        try:
            if request.method.upper() in ("GET", "DELETE", "HEAD"):
                resp = await client.request(
                    method=request.method,
                    url=url,
                    headers=headers,
                    params=request.params,
                )
            else:
                resp = await client.request(
                    method=request.method,
                    url=url,
                    headers=headers,
                    params=request.params,
                    json=request.body,
                )
        except httpx.TimeoutException as exc:
            raise GatewayAdapterError(
                f"Gateway request timed out (fail-closed): {exc}"
            ) from exc
        except httpx.HTTPError as exc:
            raise GatewayAdapterError(
                f"Gateway unreachable (fail-closed): {exc}"
            ) from exc

        elapsed = (time.monotonic() - start) * 1000
        self._raise_if_gateway_error(resp)

        return SDKResponse(
            status_code=resp.status_code,
            headers=dict(resp.headers),
            body=self._parse_body(resp),
            elapsed_ms=elapsed,
        )

    async def _send_direct(
        self, client: httpx.AsyncClient, request: SDKRequest
    ) -> SDKResponse:
        """Direct call to the Caracal API (OSS broker path)."""
        base = self._broker_base
        if not base:
            raise GatewayAdapterError(
                "No gateway endpoint and no explicit broker_base_url configured."
            )
        url = f"{base}{request.path}"
        start = time.monotonic()
        if request.method.upper() in ("GET", "DELETE", "HEAD"):
            resp = await client.request(
                method=request.method,
                url=url,
                headers=request.headers,
                params=request.params,
            )
        else:
            resp = await client.request(
                method=request.method,
                url=url,
                headers=request.headers,
                params=request.params,
                json=request.body,
            )
        elapsed = (time.monotonic() - start) * 1000
        return SDKResponse(
            status_code=resp.status_code,
            headers=dict(resp.headers),
            body=self._parse_body(resp),
            elapsed_ms=elapsed,
        )

    def _raise_if_gateway_error(self, resp: httpx.Response) -> None:
        """Translate gateway-specific error codes to typed exceptions."""
        if resp.status_code == 401:
            raise GatewayAdapterError("Gateway rejected API key (401 Unauthorized).")
        if resp.status_code == 403:
            body = self._parse_body(resp) or {}
            error = body.get("error", "forbidden") if isinstance(body, dict) else "forbidden"
            if error == "mandate_revoked":
                from caracal_sdk._compat import AuthorityDeniedError
                raise AuthorityDeniedError("Mandate has been revoked.")
            if error == "provider_not_allowed":
                raise GatewayAdapterError(
                    f"Provider not in registry: {body.get('message', '')}"
                )
            raise GatewayAdapterError(f"Gateway denied request: {error}")
        if resp.status_code == 429:
            body = self._parse_body(resp) or {}
            raise GatewayAdapterError(
                f"Quota exceeded: {body.get('dimension', 'unknown')} "
                f"({body.get('current')}/{body.get('limit')})"
            )
        if resp.status_code == 503:
            raise GatewayAdapterError("Gateway unavailable (503).")

    @staticmethod
    def _parse_body(resp: httpx.Response) -> JsonValue | None:
        ct = resp.headers.get("content-type", "")
        if "application/json" in ct:
            try:
                return resp.json()
            except Exception:
                return resp.text
        return resp.text or None


def build_gateway_adapter(
    workspace_id: Optional[str] = None,
    broker_base_url: Optional[str] = None,
) -> GatewayAdapter:
    """
    Convenience factory: build a GatewayAdapter from environment feature flags.

    Returns a GatewayAdapter configured from CARACAL_GATEWAY_* env vars.
    OSS users without gateway flags configured must provide an explicit
    broker base URL if they want direct broker transport.
    """
    flags = get_gateway_features()
    return GatewayAdapter(
        gateway_endpoint=flags.gateway_endpoint,
        gateway_api_key=flags.gateway_api_key,
        workspace_id=workspace_id,
        broker_base_url=broker_base_url,
        feature_flags=flags,
    )
