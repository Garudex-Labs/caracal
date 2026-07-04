"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Control API client that mints a scoped, single-use Caracal token per call and invokes a control command through the governed /v1/control/invoke path.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

import httpx

STS_TOKEN_PATH = "/oauth/2/token"
CONTROL_INVOKE_PATH = "/v1/control/invoke"
DEFAULT_TIMEOUT_SECONDS = 30.0


class ControlClientError(RuntimeError):
    """A control invoke failed. stage distinguishes a token-exchange failure
    from a control dispatch failure; status 0 means the request itself failed
    and no response arrived. reason is already free of the client secret, so it
    is safe to surface or log. code and remediation are the structured
    control-plane fields when the failure came from dispatch."""

    def __init__(
        self,
        stage: str,
        status: int,
        reason: str,
        code: str | None = None,
        remediation: str | None = None,
    ) -> None:
        super().__init__(f"control {stage} failed ({status}): {reason}")
        self.stage = stage
        self.status = status
        self.reason = reason
        self.code = code
        self.remediation = remediation

    @property
    def definitive(self) -> bool:
        """Whether the failure provably applied nothing: any token-stage
        failure (no token was minted, so nothing was invoked) or an invoke the
        control plane rejected with a client error. An invoke-stage server
        error or lost response is not definitive - the command may already
        have applied - so a caller must never blindly retry it."""
        return self.stage == "token" or 400 <= self.status < 500


def _read_json(res: httpx.Response) -> Any:
    text = res.text
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return {"raw": text}


def _describe_error(body: Any, fallback: str) -> tuple[str, str | None, str | None]:
    envelope = body.get("error") if isinstance(body, dict) else None
    if isinstance(envelope, dict):
        return (
            envelope.get("reason") or fallback,
            envelope.get("code"),
            envelope.get("remediation"),
        )
    if isinstance(envelope, str):
        return envelope, None, None
    return fallback, None, None


class ControlClient:
    """A control-plane client bound to one identity. Each invoke mints a fresh
    token scoped to exactly the scopes that call requires, so an action
    carries the least authority that satisfies it and a leaked token grants
    nothing beyond that one operation. The client secret is a sealed
    credential that leaves this module only in the token-exchange request body
    to the STS and is never logged."""

    def __init__(
        self,
        *,
        sts_url: str,
        control_url: str,
        audience: str,
        application_id: str,
        client_secret: str,
        ttl_seconds: int | None = None,
        zone_scope: str | None = None,
        authorized_by: str | None = None,
        co_author_operator: bool = False,
        request_id: str | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self._sts_url = sts_url.rstrip("/")
        self._control_url = control_url.rstrip("/")
        self._audience = audience
        self._application_id = application_id
        self._client_secret = client_secret
        self._ttl_seconds = ttl_seconds
        self._zone_scope = zone_scope
        self._authorized_by = authorized_by
        self._co_author_operator = co_author_operator
        self._request_id = request_id
        self._http = (
            http_client
            if http_client is not None
            else httpx.Client(timeout=DEFAULT_TIMEOUT_SECONDS)
        )

    def _mint_token(self, scopes: Sequence[str]) -> str:
        """Exchanges the identity's client credentials for a control token
        scoped to exactly the requested scopes. A transient failure (a server
        error or a lost response) is retried once: a failed mint is always
        definitive - no token exists and nothing was applied - so the retry is
        safe for every caller."""
        try:
            return self._exchange_token(scopes)
        except ControlClientError as err:
            if err.status >= 500 or err.status == 0:
                return self._exchange_token(scopes)
            raise

    def _exchange_token(self, scopes: Sequence[str]) -> str:
        form = {
            "grant_type": "client_credentials",
            "application_id": self._application_id,
            "client_secret": self._client_secret,
            "resource": self._audience,
            "scope": " ".join(scopes),
        }
        if self._ttl_seconds is not None:
            form["ttl_seconds"] = str(self._ttl_seconds)
        headers = {}
        if self._request_id:
            headers["x-request-id"] = self._request_id
        res = self._send(
            "token", f"{self._sts_url}{STS_TOKEN_PATH}", data=form, headers=headers
        )
        body = _read_json(res)
        if res.is_error:
            reason, code, remediation = _describe_error(body, "token exchange rejected")
            raise ControlClientError(
                "token", res.status_code, reason, code, remediation
            )
        token = body.get("access_token") if isinstance(body, dict) else None
        if not isinstance(token, str) or not token:
            raise ControlClientError(
                "token", res.status_code, "token exchange returned no access_token"
            )
        return token

    def _send(self, stage: str, url: str, **kwargs: Any) -> httpx.Response:
        """Carries a request to the wire, normalizing a raised transport
        failure into the error taxonomy as status 0 so every failure a caller
        sees carries a stage and a status."""
        try:
            return self._http.post(url, **kwargs)
        except httpx.HTTPError as err:
            raise ControlClientError(
                stage, 0, str(err) or "network request failed"
            ) from err

    def invoke(
        self,
        command: str,
        subcommand: str,
        flags: dict[str, Any],
        scopes: Sequence[str],
    ) -> Any:
        token = self._mint_token(scopes)
        headers = {"authorization": f"Bearer {token}"}
        if self._zone_scope:
            headers["x-caracal-zone-scope"] = self._zone_scope
        if self._request_id:
            headers["x-request-id"] = self._request_id
        invoke_body: dict[str, Any] = {
            "command": command,
            "subcommand": subcommand,
            "flags": flags,
        }
        if self._authorized_by:
            invoke_body["authorized_by"] = self._authorized_by
        if self._co_author_operator:
            invoke_body["co_author_operator"] = True
        res = self._send(
            "invoke",
            f"{self._control_url}{CONTROL_INVOKE_PATH}",
            json=invoke_body,
            headers=headers,
        )
        body = _read_json(res)
        if res.is_error:
            reason, code, remediation = _describe_error(body, "control invoke rejected")
            raise ControlClientError(
                "invoke", res.status_code, reason, code, remediation
            )
        return body.get("result") if isinstance(body, dict) else None
