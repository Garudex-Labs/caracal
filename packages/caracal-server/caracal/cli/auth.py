"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

CLI commands for authentication token minting.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import click
import httpx


@click.group(name="auth")
def auth() -> None:
    """Manage local authentication helpers."""


def _caracal_home() -> Path:
    raw = os.environ.get("CCL_HOME", "").strip()
    return Path(raw).expanduser() if raw else Path.home() / ".caracal"


def _read_runtime_env_value(key: str) -> str | None:
    env_value = os.environ.get(key, "").strip()
    if env_value:
        return env_value

    env_path = _caracal_home() / ".env"
    if not env_path.exists():
        return None
    prefix = f"{key}="
    for line in env_path.read_text(encoding="utf-8").splitlines():
        if line.strip().startswith(prefix):
            return line.split("=", 1)[1].strip() or None
    return None


def _default_ais_socket_path() -> str:
    configured = os.environ.get("CCL_AIS_UNIX_SOCKET_PATH", "").strip()
    if configured:
        return configured
    return str(_caracal_home() / "run" / "caracal-ais.sock")


def _issue_token_via_ais(
    *,
    principal_id: str,
    workspace_id: str,
    tenant_id: str,
    session_kind: str,
    directory_scope: str | None,
    include_refresh: bool,
    bearer_token: str | None,
    socket_path: str,
    api_prefix: str,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "principal_id": principal_id,
        "workspace_id": workspace_id,
        "tenant_id": tenant_id,
        "session_kind": session_kind,
        "include_refresh": include_refresh,
    }
    if directory_scope:
        payload["directory_scope"] = directory_scope

    headers: dict[str, str] = {}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"

    transport = httpx.HTTPTransport(uds=socket_path)
    url = f"http://caracal-ais{api_prefix.rstrip('/')}/token"
    try:
        with httpx.Client(transport=transport, timeout=10.0) as client:
            response = client.post(url, json=payload, headers=headers)
    except OSError as exc:
        raise click.ClickException(
            f"Unable to reach AIS Unix socket at {socket_path}. Start the runtime with 'caracal up'."
        ) from exc
    except httpx.HTTPError as exc:
        raise click.ClickException(f"AIS token request failed: {exc}") from exc

    if response.status_code >= 400:
        detail = response.text.strip() or response.reason_phrase
        raise click.ClickException(f"AIS token request rejected ({response.status_code}): {detail}")
    data = response.json()
    if not isinstance(data, dict) or not str(data.get("access_token") or "").strip():
        raise click.ClickException("AIS token response did not include an access_token.")
    return data


@auth.command(name="token")
@click.option("--principal-id", default=None, help="Principal UUID to mint a session for.")
@click.option("--workspace-id", default="default", show_default=True, help="Workspace identifier.")
@click.option("--tenant-id", default="default", show_default=True, help="Tenant identifier.")
@click.option(
    "--session-kind",
    type=click.Choice(["interactive", "automation", "task"]),
    default="automation",
    show_default=True,
    help="Session kind to mint.",
)
@click.option(
    "--format",
    "output_format",
    type=click.Choice(["text", "env", "json"]),
    default="text",
    show_default=True,
    help="Token output format.",
)
@click.option("--directory-scope", default=None, help="Optional directory scope claim.")
@click.option(
    "--include-refresh/--no-refresh",
    default=True,
    show_default=True,
    help="Request a refresh token from AIS.",
)
@click.option(
    "--bearer-token",
    default=None,
    envvar="CCL_SESS_TOKEN",
    help="Existing AIS session token used to authorize cross-principal issuance.",
)
@click.option(
    "--quiet",
    is_flag=True,
    default=False,
    help="Suppress explanatory text while still printing token output.",
)
def token(
    principal_id: str | None,
    workspace_id: str,
    tenant_id: str,
    session_kind: str,
    output_format: str,
    directory_scope: str | None,
    include_refresh: bool,
    bearer_token: str | None,
    quiet: bool,
) -> None:
    """Mint an AIS session token through the local Unix socket."""
    resolved_principal_id = (principal_id or _read_runtime_env_value("CCL_AIS_ATTESTATION_PID") or "").strip()
    if not resolved_principal_id:
        raise click.ClickException(
            "Missing --principal-id and no CCL_AIS_ATTESTATION_PID was found in the runtime environment."
        )

    token_response = _issue_token_via_ais(
        principal_id=resolved_principal_id,
        workspace_id=workspace_id,
        tenant_id=tenant_id,
        session_kind=session_kind,
        directory_scope=directory_scope,
        include_refresh=include_refresh,
        bearer_token=bearer_token,
        socket_path=_default_ais_socket_path(),
        api_prefix=os.environ.get("CCL_AIS_API_PREFIX", "/v1/ais").strip() or "/v1/ais",
    )

    access_token = str(token_response["access_token"])
    if output_format == "env":
        click.echo(f"CCL_SESS_TOKEN={access_token}")
        return
    if output_format == "json":
        click.echo(json.dumps(token_response, indent=2, sort_keys=True))
        return

    if quiet:
        click.echo(access_token)
        return

    click.echo(f"AIS session token minted for principal {resolved_principal_id}.")
    click.echo(f"export CCL_SESS_TOKEN={access_token}")
