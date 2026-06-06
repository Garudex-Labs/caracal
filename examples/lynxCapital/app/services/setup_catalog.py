"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup catalog helpers for provider credential requirements and local provider links.
"""
from __future__ import annotations

import os
from typing import Any

from app.services import partners

AUTH_LABELS = {
    "api_key": "API key",
    "bearer": "Bearer token",
    "mcp_bearer": "MCP bearer token",
    "oauth_cc": "OAuth client credentials",
    "oauth_ac": "OAuth authorization code",
    "none": "No credential",
    "mandate": "Caracal mandate",
}

AUTH_ENV_KEYS = {
    "api_key": ("API_KEY",),
    "bearer": ("TOKEN",),
    "mcp_bearer": ("TOKEN",),
    "oauth_cc": ("CLIENT_ID", "CLIENT_SECRET"),
    "oauth_ac": ("CLIENT_ID", "CLIENT_SECRET"),
}


def env_id(provider_id: str) -> str:
    return provider_id.upper().replace("-", "_")


def base_url(spec: partners.PartnerSpec) -> str:
    return os.environ.get(f"LYNX_PARTNER_{env_id(spec.id)}_URL", f"http://127.0.0.1:{spec.port}").rstrip("/")


def credential_vars(spec: partners.PartnerSpec) -> list[str]:
    return [f"LYNX_PARTNER_{env_id(spec.id)}_{key}" for key in AUTH_ENV_KEYS.get(spec.auth, ())]


def provider_entries(config_providers: list[Any]) -> list[dict[str, object]]:
    provider_config = {provider.id: provider for provider in config_providers}
    entries: list[dict[str, object]] = []
    caracal_enabled = bool(os.environ.get("CARACAL_ZONE_ID") and os.environ.get("CARACAL_APPLICATION_ID"))
    for spec in partners.catalog().values():
        provider = provider_config.get(spec.id)
        variables = credential_vars(spec)
        missing = [name for name in variables if not os.environ.get(name)]
        url = base_url(spec)
        if spec.auth == "none":
            status = "Ready"
            credentials = "No credential required"
        elif spec.auth == "mandate":
            status = "Caracal Configured" if caracal_enabled else "Requires Caracal"
            credentials = "Caracal-issued mandate"
        elif not missing:
            status = "Credentials Added"
            credentials = ", ".join(variables)
        else:
            status = "Not Configured"
            credentials = ", ".join(variables)
        entries.append({
            "id": spec.id,
            "name": provider.name if provider else spec.id.replace("-", " ").title(),
            "category": (provider.category if provider else "provider").replace("_", " ").title(),
            "auth": AUTH_LABELS.get(spec.auth, spec.auth.replace("_", " ").title()),
            "authType": provider.authType if provider else spec.auth,
            "protocol": (provider.protocol if provider else "http").upper(),
            "purpose": ", ".join(operation.replace("_", " ") for operation in spec.operations[:3]),
            "credentials": credentials,
            "variables": variables,
            "missing": missing,
            "dashboardUrl": url,
            "credentialUrl": f"{url}/__lab/clients" if spec.auth.startswith("oauth") else f"{url}/__lab/credentials",
            "documentationUrl": f"{url}/__lab/resources",
            "apiClientUrl": f"{url}/__lab/api-clients",
            "status": status,
        })
    return entries
