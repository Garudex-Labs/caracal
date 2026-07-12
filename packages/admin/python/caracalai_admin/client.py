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
MAX_LIST_PAGES = 50


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


def _api_error(res: httpx.Response, target: str = "api") -> AdminApiError:
    text = res.text
    parsed: Any = text
    code = res.reason_phrase or "request_failed"
    try:
        parsed = json.loads(text) if text else {}
        if isinstance(parsed, dict) and isinstance(parsed.get("error"), str):
            code = parsed["error"]
    except ValueError:
        pass
    return AdminApiError(res.status_code, code, parsed, target=target)


def _grant_list_query(query: dict[str, Any] | None) -> dict[str, Any]:
    params = dict(query or {})
    scopes = params.pop("scopes", None)
    subject_id = params.pop("subject_id", None)
    user_id = params.pop("user_id", None)
    params["user_id"] = user_id if user_id is not None else subject_id
    params["scopes"] = ",".join(scopes) if scopes is not None else None
    return params


def _unwrap(response: Any, key: str, message: str) -> list[Any]:
    value = response.get(key) if isinstance(response, dict) else None
    if not isinstance(value, list):
        raise RuntimeError(message)
    return value


class AdminClient:
    """Admin API client covering provisioning (zones, applications,
    resources, providers, policies, policy sets, policy templates, grants)
    and operations (authority records, sessions, audit, approvals, delegations) surfaces.
    Responses are the parsed JSON bodies. Only idempotent (GET/HEAD) requests
    are retried, on transient statuses with jittered backoff honoring
    Retry-After. Coordinator-backed surfaces require coordinator_url and
    coordinator_token."""

    def __init__(
        self,
        *,
        api_url: str,
        admin_token: str,
        coordinator_url: str | None = None,
        coordinator_token: str | None = None,
        http_client: httpx.Client | None = None,
        timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS,
        retries: int = DEFAULT_RETRIES,
        headers: dict[str, str] | None = None,
    ) -> None:
        self._api_url = api_url.rstrip("/")
        self._admin_token = admin_token
        self._coordinator_url = coordinator_url.rstrip("/") if coordinator_url else None
        self._coordinator_token = coordinator_token
        self._http = http_client if http_client is not None else httpx.Client()
        self._timeout = timeout_seconds
        self._retries = retries
        self._headers = dict(headers) if headers else {}
        self.zones = _Zones(self)
        self.applications = _Applications(self)
        self.resources = _Resources(self)
        self.providers = _Providers(self)
        self.policies = _Policies(self)
        self.policy_templates = _PolicyTemplates(self)
        self.policy_sets = _PolicySets(self)
        self.grants = _Grants(self)
        self.subject_issuers = _SubjectIssuers(self)
        self.provider_connections = _ProviderConnections(self)
        self.workloads = _Workloads(self)
        self.authority_records = _AuthorityRecords(self)
        self.subjects = _Subjects(self)
        self.sessions = _Sessions(self)
        self.audit = _Audit(self)
        self.admin_audit = _AdminAudit(self)
        self.step_up_challenges = _StepUpChallenges(self)
        self.delegations = _Delegations(self)

    def with_default_headers(self, headers: dict[str, str]) -> AdminClient:
        """Returns a derived client sharing this client's transport and
        configuration with the given headers merged over the defaults."""
        return AdminClient(
            api_url=self._api_url,
            admin_token=self._admin_token,
            coordinator_url=self._coordinator_url,
            coordinator_token=self._coordinator_token,
            http_client=self._http,
            timeout_seconds=self._timeout,
            retries=self._retries,
            headers={**self._headers, **headers},
        )

    def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        base: str = "api",
        query: dict[str, Any] | None = None,
        body: Any | None = None,
        expect_empty: bool = False,
    ) -> Any:
        if base == "coordinator":
            if not self._coordinator_url:
                raise RuntimeError("coordinator_url_not_configured")
            if not self._coordinator_token:
                raise RuntimeError("coordinator_token_not_configured")
            url = self._coordinator_url + path
            token = self._coordinator_token
        else:
            url = self._api_url + path
            token = self._admin_token
        params = {k: v for k, v in (query or {}).items() if v is not None and v != ""}
        headers = {"Authorization": f"Bearer {token}", **self._headers}
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
                raise _api_error(res, base)
            if expect_empty or res.status_code == 204:
                return None
            return res.json()
        raise RuntimeError("admin request exhausted")

    def _list_all(
        self, path: str, label: str, query: dict[str, Any] | None = None
    ) -> list[Any]:
        """Drains a keyset-paginated collection by following next_cursor until
        exhausted, so a list is the complete collection rather than a silently
        truncated first page. The page cap bounds the walk against a server bug
        that never terminates the cursor chain."""
        items: list[Any] = []
        cursor: str | None = None
        for _ in range(MAX_LIST_PAGES):
            response = self._request(path, query={**(query or {}), "cursor": cursor})
            items.extend(_unwrap(response, "items", f"{label} response missing items"))
            cursor = response.get("next_cursor") if isinstance(response, dict) else None
            if not cursor:
                return items
        raise RuntimeError(f"{label} pagination did not terminate")


class _Zones:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self) -> Any:
        return self._client._list_all("/v1/zones", "zones")

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
        return self._client._list_all(
            f"/v1/zones/{zone_id}/applications", "applications"
        )

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
        plaintext secret and the sealed custody copy in the Secret Store is
        replaced with it."""
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}/rotate-secret",
            method="POST",
        )

    def get_client_secret(self, zone_id: str, application_id: str) -> Any:
        """Retrieves the client secret from Secret Store custody. Every call
        is recorded in the zone audit timeline as a credential reveal."""
        return self._client._request(
            f"/v1/zones/{zone_id}/applications/{application_id}/client-secret"
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
        return self._client._list_all(f"/v1/zones/{zone_id}/resources", "resources")

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
        return self._client._list_all(f"/v1/zones/{zone_id}/providers", "providers")

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
        return self._client._list_all(f"/v1/zones/{zone_id}/policies", "policies")

    def get(self, zone_id: str, policy_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/policies/{policy_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policies", method="POST", body=body
        )

    def validate(self, content: str) -> Any:
        return self._client._request(
            "/v1/policies/validate", method="POST", body={"content": content}
        )

    def add_version(self, zone_id: str, policy_id: str, content: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policies/{policy_id}/versions",
            method="POST",
            body={"content": content},
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
        return self._client._list_all(f"/v1/zones/{zone_id}/policy-sets", "policy sets")

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
    ) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/versions",
            method="POST",
            body={"manifest": manifest},
        )

    def list_versions(self, zone_id: str, set_id: str) -> Any:
        return self._client._list_all(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/versions",
            "policy set versions",
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

    def activate(self, zone_id: str, set_id: str, version_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/activate",
            method="POST",
            body={"version_id": version_id},
        )

    def activation_status(
        self,
        zone_id: str,
        set_id: str,
        version_id: str | None = None,
        outbox_id: str | None = None,
    ) -> Any:
        query: dict[str, Any] = {}
        if version_id is not None:
            query["version_id"] = version_id
        if outbox_id is not None:
            query["outbox_id"] = outbox_id
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}/activation-status",
            query=query or None,
        )

    def delete(self, zone_id: str, set_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/policy-sets/{set_id}",
            method="DELETE",
            expect_empty=True,
        )


class _PolicyTemplates:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self) -> Any:
        return self._client._request("/v1/policy-templates")

    def get(self, template_id: str) -> Any:
        templates = self.list()
        for template in templates:
            if isinstance(template, dict) and template.get("id") == template_id:
                return template
        raise AdminApiError(
            404,
            "policy_template_not_found",
            {"error": "policy_template_not_found", "id": template_id},
        )


class _Grants:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str, query: dict[str, Any] | None = None) -> Any:
        return self._client._list_all(
            f"/v1/zones/{zone_id}/grants", "grants", query=_grant_list_query(query)
        )

    def get(self, zone_id: str, grant_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/grants/{grant_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/grants", method="POST", body=body
        )

    def revoke(self, zone_id: str, grant_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/grants/{grant_id}",
            method="DELETE",
            expect_empty=True,
        )


class _SubjectIssuers:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._list_all(
            f"/v1/zones/{zone_id}/subject-issuers", "subject issuers"
        )

    def get(self, zone_id: str, issuer_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/subject-issuers/{issuer_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/subject-issuers", method="POST", body=body
        )

    def patch(self, zone_id: str, issuer_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/subject-issuers/{issuer_id}",
            method="PATCH",
            body=body,
        )

    def delete(self, zone_id: str, issuer_id: str) -> None:
        return self._client._request(
            f"/v1/zones/{zone_id}/subject-issuers/{issuer_id}",
            method="DELETE",
            expect_empty=True,
        )


class _ProviderConnections:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/provider-connections", method="POST", body=body
        )

    def authorize_oauth(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/provider-connections/oauth/authorize",
            method="POST",
            body=body,
        )

    def revoke(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/provider-connections/revoke", method="POST", body=body
        )


class _Workloads:
    """Workload launcher identities and their credential bindings; create and
    rotate_secret responses carry the plaintext secret, and a sealed custody
    copy stays retrievable through get_secret."""

    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> list[Any]:
        return self._client._list_all(f"/v1/zones/{zone_id}/workloads", "workloads")

    def get(self, zone_id: str, workload_id: str) -> Any:
        return self._client._request(f"/v1/zones/{zone_id}/workloads/{workload_id}")

    def create(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/workloads", method="POST", body=body
        )

    def update(self, zone_id: str, workload_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/workloads/{workload_id}", method="PUT", body=body
        )

    def rotate_secret(self, zone_id: str, workload_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/workloads/{workload_id}/rotate-secret",
            method="POST",
        )

    def get_secret(self, zone_id: str, workload_id: str) -> Any:
        """Retrieves the workload secret from Secret Store custody. Every call
        is recorded in the zone audit timeline as a credential reveal."""
        return self._client._request(
            f"/v1/zones/{zone_id}/workloads/{workload_id}/secret"
        )

    def delete(self, zone_id: str, workload_id: str) -> None:
        self._client._request(
            f"/v1/zones/{zone_id}/workloads/{workload_id}",
            method="DELETE",
            expect_empty=True,
        )


class _AuthorityRecords:
    """Reads STS authority records."""

    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str, query: dict[str, Any] | None = None) -> Any:
        response = self._client._request(
            f"/v1/zones/{zone_id}/authority-records", query=query
        )
        return _unwrap(response, "items", "authority-records response missing items")


class _Subjects:
    """The subject kill switch: one call cuts every authority path a subject
    holds - session records, governed sessions riding them, delegations, and
    provider connections - and feeds the revocation stream so in-flight
    mandates die before their exp. Idempotent."""

    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def revoke(self, zone_id: str, body: dict[str, Any]) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/subjects/revoke", method="POST", body=body
        )


def _map_session(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    session = dict(value)
    session["session_id"] = session.pop("agent_session_id", None)
    session["parent_session_id"] = session.pop("parent_id", None)
    session["authority_record_id"] = session.pop("subject_authority_record_id", None)
    return session


def _map_delegation(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    delegation = dict(value)
    delegation["delegation_id"] = delegation.pop("id", None)
    delegation["parent_delegation_id"] = delegation.pop("parent_edge_id", None)
    return delegation


def _map_delegation_traversal(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    node = dict(value)
    node["delegation_id"] = node.pop("id", None)
    return node


class _Sessions:
    """Reads and manages governed sessions."""

    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str, query: dict[str, Any] | None = None) -> Any:
        response = self._client._request(
            f"/v1/zones/{zone_id}/sessions", query=dict(query or {})
        )
        return _unwrap(response, "items", "sessions response missing items")

    def get(self, zone_id: str, session_id: str) -> Any:
        return _map_session(
            self._client._request(
                f"/zones/{zone_id}/agents/{session_id}", base="coordinator"
            )
        )

    def children(
        self, zone_id: str, session_id: str, query: dict[str, Any] | None = None
    ) -> Any:
        response = self._client._request(
            f"/zones/{zone_id}/agents/{session_id}/children",
            base="coordinator",
            query=query,
        )
        return [
            _map_session(item)
            for item in _unwrap(
                response, "items", "session children response missing items"
            )
        ]

    def suspend(self, zone_id: str, session_id: str) -> Any:
        return self._client._request(
            f"/zones/{zone_id}/agents/{session_id}/suspend",
            method="PATCH",
            base="coordinator",
        )

    def resume(self, zone_id: str, session_id: str) -> Any:
        return self._client._request(
            f"/zones/{zone_id}/agents/{session_id}/resume",
            method="PATCH",
            base="coordinator",
        )

    def terminate(self, zone_id: str, session_id: str) -> None:
        return self._client._request(
            f"/zones/{zone_id}/agents/{session_id}",
            method="DELETE",
            base="coordinator",
            expect_empty=True,
        )

    def effective_authority(self, zone_id: str, session_id: str) -> Any:
        authority = self._client._request(
            f"/zones/{zone_id}/agents/{session_id}/effective-authority",
            base="coordinator",
        )
        if isinstance(authority, dict):
            authority = dict(authority)
            authority["session_id"] = authority.pop("agent_session_id", None)
            authority["inbound_delegations"] = authority.pop("inbound_edges", [])
        return authority


class _Audit:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str, query: dict[str, Any] | None = None) -> Any:
        response = self._client._request(f"/v1/zones/{zone_id}/audit", query=query)
        return _unwrap(response, "items", "audit response missing items")

    def by_request(self, zone_id: str, request_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/audit/by-request/{request_id}"
        )

    def explain(self, zone_id: str, request_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/audit/by-request/{request_id}/explain"
        )


class _AdminAudit:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str, query: dict[str, Any] | None = None) -> Any:
        response = self._client._request(
            f"/v1/zones/{zone_id}/admin-audit", query=query
        )
        return _unwrap(response, "items", "admin audit response missing items")


class _StepUpChallenges:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def list(self, zone_id: str) -> Any:
        return self._client._list_all(
            f"/v1/zones/{zone_id}/step-up-challenges", "step-up challenges"
        )

    def get(self, zone_id: str, challenge_id: str) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/step-up-challenges/{challenge_id}"
        )

    def approve(
        self, zone_id: str, challenge_id: str, reason: str | None = None
    ) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/step-up-challenges/{challenge_id}/approve",
            method="POST",
            body={"reason": reason} if reason else {},
        )

    def reject(self, zone_id: str, challenge_id: str, reason: str | None = None) -> Any:
        return self._client._request(
            f"/v1/zones/{zone_id}/step-up-challenges/{challenge_id}/reject",
            method="POST",
            body={"reason": reason} if reason else {},
        )


class _Delegations:
    def __init__(self, client: AdminClient) -> None:
        self._client = client

    def active(self, zone_id: str) -> Any:
        page = self._client._request(
            f"/zones/{zone_id}/delegations/active", base="coordinator"
        )
        if isinstance(page, dict) and isinstance(page.get("items"), list):
            page = dict(page)
            page["items"] = [_map_delegation(item) for item in page["items"]]
        return page

    def inbound(self, zone_id: str, session_id: str) -> Any:
        return [
            _map_delegation(item)
            for item in self._client._request(
                f"/zones/{zone_id}/delegations/inbound/{session_id}",
                base="coordinator",
            )
        ]

    def outbound(self, zone_id: str, session_id: str) -> Any:
        return [
            _map_delegation(item)
            for item in self._client._request(
                f"/zones/{zone_id}/delegations/outbound/{session_id}",
                base="coordinator",
            )
        ]

    def traverse(self, zone_id: str, delegation_id: str) -> Any:
        return [
            _map_delegation_traversal(item)
            for item in self._client._request(
                f"/zones/{zone_id}/delegations/{delegation_id}/traverse",
                base="coordinator",
            )
        ]

    def impact(self, zone_id: str, delegation_id: str) -> Any:
        impact = self._client._request(
            f"/zones/{zone_id}/delegations/{delegation_id}/impact",
            base="coordinator",
        )
        if isinstance(impact, dict):
            impact = dict(impact)
            impact["delegation_id"] = impact.pop("edge_id", None)
            impact["affected_delegations"] = [
                _map_delegation_traversal(item)
                for item in impact.pop("affected_edges", [])
            ]
            impact["affected_sessions"] = impact.pop("affected_agents", [])
        return impact

    def revoke(self, zone_id: str, delegation_id: str) -> Any:
        result = self._client._request(
            f"/zones/{zone_id}/delegations/{delegation_id}/revoke",
            method="PATCH",
            base="coordinator",
        )
        if isinstance(result, dict):
            result = dict(result)
            result["revoked_delegations"] = result.pop("revoked_edges", 0)
        return result
