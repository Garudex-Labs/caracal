"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Lynx Capital provisioning glue over the packaged caracalai-admin Control client.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx
from caracalai_admin import ControlClient, ControlClientError
from dotenv import load_dotenv

STS_TOKEN_PATH = "/oauth/2/token"

# Operator provisioning environment is sourced separately from the workload .env; never
# load the managed application's runtime credentials here.
load_dotenv(Path(__file__).resolve().parent.parent / ".env.provision", override=False)


class ControlError(RuntimeError):
    pass


_SCOPE_KINDS = {"list": "read", "get": "read", "delete": "delete"}


def scopes_for(command: str, subcommand: str) -> list[str]:
    """The least-privilege Control scope one invoke needs. The command names the scope
    family and the subcommand its access kind, so every minted token carries exactly one
    scope and authorizes nothing beyond that operation."""
    return [f"control:{command}:{_SCOPE_KINDS.get(subcommand, 'write')}"]


class LynxControl:
    """Drives the zone-bound management catalog (`app`, `identity-provider`, `resource`,
    `policy`, `policy-set`) through the packaged Control client. Each invoke mints a fresh
    single-scope token; the key is application-only and short-TTL, so it can create the
    zone's objects but holds no runtime data authority. A rate-limited call is definitive
    (nothing was applied), so it is paced and retried."""

    def __init__(
        self,
        *,
        sts_url: str,
        control_url: str,
        audience: str,
        client_id: str,
        client_secret: str,
        ttl_seconds: int | None = None,
    ):
        self._sts_url = sts_url
        self._audience = audience
        self._client_id = client_id
        self._client_secret = client_secret
        self._client = ControlClient(
            sts_url=sts_url,
            control_url=control_url,
            audience=audience,
            application_id=client_id,
            client_secret=client_secret,
            ttl_seconds=ttl_seconds,
        )

    def invoke(self, command: str, subcommand: str, flags: dict | None = None) -> object:
        for attempt in range(4):
            try:
                return self._client.invoke(
                    command, subcommand, flags or {}, scopes_for(command, subcommand)
                )
            except ControlClientError as err:
                if err.status == 429 and attempt < 3:
                    match = re.search(r"\d+", err.reason or "")
                    wait = min(int(match.group()) if match else 30, 120)
                    print(f"rate limited; retrying in {wait}s", file=sys.stderr)
                    time.sleep(wait + 1)
                    continue
                raise
        raise ControlError(f"{command} {subcommand} rate limited after retries")

    def run(self, command: dict) -> object:
        """Invoke a plan command of the form built by app.tenancy."""
        return self.invoke(
            command["command"], command["subcommand"], command.get("flags")
        )

    def bound_zone(self) -> str:
        """The authoritative zone the Control key is bound to, read from the zone_id claim
        of a discovery token. The packaged client never surfaces raw tokens, so the
        discovery exchange happens here; the token is read once and discarded. Provisioning
        records this zone so the workload can detect and refuse a credential set that was
        minted for a different zone before it fails at token exchange."""
        form = {
            "grant_type": "client_credentials",
            "application_id": self._client_id,
            "client_secret": self._client_secret,
            "resource": self._audience,
            "scope": "control:app:read",
        }
        try:
            response = httpx.post(
                f"{self._sts_url}{STS_TOKEN_PATH}", data=form, timeout=20.0
            )
        except httpx.HTTPError as exc:
            raise ControlError(f"zone discovery unreachable: {exc}") from None
        if response.is_error:
            raise ControlError(
                f"zone discovery token exchange failed ({response.status_code}): "
                f"{response.text[:200]}"
            )
        token = response.json().get("access_token", "")
        zone = str(_jwt_claims(token).get("zone_id", "")).strip()
        if not zone:
            raise ControlError("control token did not carry a zone_id claim")
        return zone


def client_from_env(env: dict[str, str] | None = None) -> LynxControl:
    if env is None:
        env = dict(os.environ)
    missing = [
        name
        for name in ("CONTROL_CLIENT_ID", "CONTROL_CLIENT_SECRET")
        if not env.get(name, "").strip()
    ]
    if missing:
        raise ControlError(f"missing required environment values: {', '.join(missing)}")
    ttl = env.get("CONTROL_TTL_SECONDS", "").strip()
    return LynxControl(
        sts_url=env.get("STS_URL", "http://127.0.0.1:8080").rstrip("/"),
        control_url=env.get("CONTROL_URL", "http://127.0.0.1:3000").rstrip("/"),
        audience=env.get("CONTROL_AUDIENCE", "caracal-control"),
        client_id=env["CONTROL_CLIENT_ID"],
        client_secret=env["CONTROL_CLIENT_SECRET"],
        ttl_seconds=int(ttl) if ttl else None,
    )


def _jwt_claims(token: str) -> dict:
    """Decode the claims segment of a compact JWS without verifying its signature. The token
    is issued by this deployment's STS to the caller, so reading its own zone_id claim needs
    no verification; the claim is only used to bind provisioning artifacts to a zone."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ControlError("control token is not a JWT")
    payload = parts[1]
    payload += "=" * (-len(payload) % 4)
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload))
    except (ValueError, json.JSONDecodeError) as exc:
        raise ControlError(f"control token payload is unreadable: {exc}") from None
    if not isinstance(claims, dict):
        raise ControlError("control token payload is not an object")
    return claims


def find_by_identifier(items: object, identifier: str) -> dict | None:
    if isinstance(items, list):
        return next(
            (
                item
                for item in items
                if isinstance(item, dict) and item.get("identifier") == identifier
            ),
            None,
        )
    return None


def find_by_name(items: object, name: str) -> dict | None:
    if isinstance(items, list):
        return next(
            (
                item
                for item in items
                if isinstance(item, dict) and item.get("name") == name
            ),
            None,
        )
    return None
