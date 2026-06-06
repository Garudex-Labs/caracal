"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Control API client that exchanges a scoped control key for a short-lived STS token and invokes management commands.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

STS_TOKEN_PATH = "/oauth/2/token"
CONTROL_INVOKE_PATH = "/v1/control/invoke"

SCOPES = [
    "control:identity-provider:read",
    "control:identity-provider:write",
    "control:resource:read",
    "control:resource:write",
    "control:policy:read",
    "control:policy:write",
]

load_dotenv(Path(__file__).resolve().parent.parent / ".env")


@dataclass
class ControlConfig:
    sts_url: str
    control_url: str
    audience: str
    client_id: str
    client_secret: str
    scopes: list[str] = field(default_factory=lambda: list(SCOPES))


class ControlError(RuntimeError):
    pass


def config_from_env(env: dict[str, str] | None = None) -> ControlConfig:
    env = env or dict(os.environ)
    missing = [
        name
        for name in ("CONTROL_CLIENT_ID", "CONTROL_CLIENT_SECRET")
        if not env.get(name, "").strip()
    ]
    if missing:
        raise ControlError(f"missing required environment values: {', '.join(missing)}")
    scopes = env.get("CONTROL_SCOPES", "").replace(",", " ").split()
    return ControlConfig(
        sts_url=env.get("STS_URL", "http://127.0.0.1:8080").rstrip("/"),
        control_url=env.get("CONTROL_URL", "http://127.0.0.1:8087").rstrip("/"),
        audience=env.get("CONTROL_AUDIENCE", "caracal-control"),
        client_id=env["CONTROL_CLIENT_ID"],
        client_secret=env["CONTROL_CLIENT_SECRET"],
        scopes=scopes or list(SCOPES),
    )


class ControlClient:
    def __init__(self, config: ControlConfig):
        self._config = config
        self._token: str | None = None

    def _post(self, url: str, body: bytes, headers: dict[str, str]) -> dict:
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise ControlError(f"{url} -> {exc.code}: {detail}") from None
        except urllib.error.URLError as exc:
            raise ControlError(f"{url} unreachable: {exc.reason}") from None
        return json.loads(payload) if payload else {}

    def token(self) -> str:
        if self._token:
            return self._token
        import urllib.parse

        form = {
            "grant_type": "client_credentials",
            "application_id": self._config.client_id,
            "client_secret": self._config.client_secret,
            "resource": self._config.audience,
            "scope": " ".join(self._config.scopes),
        }
        body = urllib.parse.urlencode(form).encode("utf-8")
        result = self._post(
            f"{self._config.sts_url}{STS_TOKEN_PATH}",
            body,
            {"content-type": "application/x-www-form-urlencoded"},
        )
        access = result.get("access_token")
        if not access:
            raise ControlError("token exchange returned no access_token")
        self._token = access
        return access

    def invoke(self, command: str, subcommand: str, flags: dict | None = None) -> object:
        body = json.dumps({"command": command, "subcommand": subcommand, "flags": flags or {}}).encode("utf-8")
        result = self._post(
            f"{self._config.control_url}{CONTROL_INVOKE_PATH}",
            body,
            {"content-type": "application/json", "authorization": f"Bearer {self.token()}"},
        )
        return result.get("result")


def find_by_identifier(items: object, identifier: str) -> dict | None:
    if isinstance(items, list):
        return next((item for item in items if isinstance(item, dict) and item.get("identifier") == identifier), None)
    return None


def find_by_name(items: object, name: str) -> dict | None:
    if isinstance(items, list):
        return next((item for item in items if isinstance(item, dict) and item.get("name") == name), None)
    return None
