"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

AdminClient: typed wrapper over the Caracal admin API provisioning surface.
"""

from __future__ import annotations

import json
import random
import time
from email.utils import parsedate_to_datetime
from typing import Any

import httpx

from .errors import AdminApiError

DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_RETRIES = 3
MAX_RETRY_AFTER_SECONDS = 30.0


def _jitter_backoff(attempt: int) -> float:
    base = min(2**attempt * 0.25, 5.0)
    return base / 2 + random.random() * (base / 2)


def _should_retry(status: int) -> bool:
    return status in (408, 425, 429) or 500 <= status < 600


def _retry_after_seconds(res: httpx.Response) -> float | None:
    header = res.headers.get("retry-after")
    if not header:
        return None
    try:
        return min(MAX_RETRY_AFTER_SECONDS, max(0.0, float(header)))
    except ValueError:
        pass
    try:
        date = parsedate_to_datetime(header)
    except (TypeError, ValueError):
        return None
    return min(MAX_RETRY_AFTER_SECONDS, max(0.0, date.timestamp() - time.time()))


def _api_error(res: httpx.Response) -> AdminApiError:
    text = res.text
    parsed: Any = text
    code = res.reason_phrase or "request_failed"
    try:
        parsed = json.loads(text) if text else {}
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
            code = parsed["error"]
    except ValueError:
        pass
    return AdminApiError(res.status_code, code, parsed)


class AdminClient:
    """Admin API client covering the provisioning surface: zones,
    applications, resources, providers, policies, and policy sets. Responses
    are the parsed JSON bodies. Only idempotent (GET/HEAD) requests are
    retried, on transient statuses with jittered backoff honoring
    Retry-After."""

    def __init__(
        self,
        *,
        api_url: str,
        admin_token: str,
        http_client: httpx.Client | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        retries: int = DEFAULT_RETRIES,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._api_url = api_url.rstrip("/")
        self._admin_token = admin_token
        self._http = http_client if http_client is not None else httpx.Client()
        self._timeout = timeout_seconds
        self._retries = retries
        self._headers = dict(headers) if headers else {}
        self.zones = _Zones(self)
        self.applications = _Applications(self)
        self.resources = _Resources(self)
        self.providers = _Providers(self)
        self.policies = _Policies(self)
        self.policy_sets = _PolicySets(self)

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        expect_empty: bool = False,
    ) -> Any:
        params = {k: v for k, v in (query or {}).items() if v is not None and v != ""}
        url = self._api_url + path
        headers = {"Authorization": f"Bearer {self._admin_token}", **self._headers}
        retries = self._retries if method in ("GET", "HEAD") else 0
        for attempt in range(retries + 1):
            try:
                res = self._http.request(
                    method,
                    url,
                    params=params or None,
                    json=body,
                    headers=headers,
                    timeout=self._timeout,
                )
            except httpx.HTTPError:
                if attempt < retries:
                    time.sleep(_jitter_backoff(attempt))
                    continue
                raise
            if res.is_error:
                if attempt < retries and _should_retry(res.status_code):
                    wait = _retry_after_seconds(res)
                    time.sleep(wait if wait is not None else _jitter_backoff(attempt))
                    continue
                raise _api_error(res)
            if expect_empty or res.status_code == 204:
                return None
            return res.json()
        raise RuntimeError("admin request exhausted")


class _Zones:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self) -> Any:
        return self._client._request("/v1/zones")

    def get(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}")

    def dcr_status(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/dcr-status")

    def create(self, body: dict[str, Any]) -> Any:
        return self._client._request("/v1/zones", method="POST", body=body)

    def patch(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}", method="PATCH", body=body)

    def delete(self, zone_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}", method="DELETE", expect_empty=True
        )


class _Applications:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/applications")

    def get(self, zone_id: str, application_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}"
        )

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/applications", method="POST", body=body
        )

    def patch(self, zone_id: str, application_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}",
            method="PATCH",
            body=body,
        )

    def rotate_secret(self, zone_id: str, application_id: str) -> Any:
        """Rotates the credential server-side; the response carries the
        one-time plaintext secret."""
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}/rotate-secret",
            method="POST",
        )

    def delete(self, zone_id: str, application_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}",
            method="DELETE",
            expect_empty=True,
        )

    def dcr(self, zone_id: str, body: dict[str, Any]) -> Any:
        """DCR (Dynamic Client Registration) is the sole programmatic path for
        minting short-lived self-registering client identities. Creation
        requires an admin token, the zone's dcr_enabled gate, and is
        rate-limited, capped per zone, and auto-expiring; the client secret is
        returned once and never retrievable again."""
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/dcr", method="POST", body=body
        )


class _Resources:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/resources")

    def get(self, zone_id: str, resource_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/resources/{resource_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/resources", method="POST", body=body
        )

    def patch(self, zone_id: str, resource_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/resources/{resource_id}", method="PATCH", body=body
        )

    def delete(self, zone_id: str, resource_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/resources/{resource_id}",
            method="DELETE",
            expect_empty=True,
        )


class _Providers:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/providers")

    def get(self, zone_id: str, provider_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/providers/{provider_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/providers", method="POST", body=body
        )

    def patch(self, zone_id: str, provider_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/providers/{provider_id}", method="PATCH", body=body
        )

    def delete(self, zone_id: str, provider_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/providers/{provider_id}",
            method="DELETE",
            expect_empty=True,
        )


class _Policies:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/policies")

    def get(self, zone_id: str, policy_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/policies/{policy_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policies", method="POST", body=body
        )

    def validate(self, content: str, schema_version: str | None = None) -> Any:
        body: dict[str, Any] = {"content": content}
        if schema_version is not None:
            body["schema_version"] = schema_version
        return self._client._request("/v1/policies/validate", method="POST", body=body)

    def add_version(
        self,
        zone_id: str,
        policy_id: str,
        content: str,
        schema_version: str | None = None,
    ) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policies/{policy_id}/versions",
            method="POST",
            body={"content": content, "schema_version": schema_version or "2026-05-20"},
        )

    def delete(self, zone_id: str, policy_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/policies/{policy_id}",
            method="DELETE",
            expect_empty=True,
        )


class _PolicySets:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/policy-sets")

    def get(self, zone_id: str, set_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/policy-sets/{set_id}")

    def create(self, zone_id: str, name: str, description: str | None = None) -> Any:
        body: dict[str, Any] = {"name": name}
        if description is not None:
            body["description"] = description
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets", method="POST", body=body
        )

    def add_version(
        self,
        zone_id: str,
        set_id: str,
        manifest: list[dict[str, Any]],
        schema_version: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"manifest": manifest}
        if schema_version is not None:
            body["schema_version"] = schema_version
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/versions",
            method="POST",
            body=body,
        )

    def simulate(
        self,
        zone_id: str,
        set_id: str,
        version_id: str,
        input: dict[str, Any] | None = None,
    ) -> Any:
        body: dict[str, Any] = {"version_id": version_id}
        if input is not None:
            body["input"] = input
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/simulate",
            method="POST",
            body=body,
        )

    def activate(
        self,
        zone_id: str,
        set_id: str,
        version_id: str,
        shadow_version_id: str | None = None,
    ) -> Any:
        body: dict[str, Any] = {"version_id": version_id}
        if shadow_version_id is not None:
            body["shadow_version_id"] = shadow_version_id
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/activate",
            method="POST",
            body=body,
        )

    def delete(self, zone_id: str, set_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}",
            method="DELETE",
            expect_empty=True,
        )
