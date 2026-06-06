"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup catalog helpers for Caracal resources and provider setup links.
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

CREDENTIAL_REQUIREMENTS = {
    "api_key": "API key",
    "bearer": "Bearer token",
    "mcp_bearer": "MCP bearer token",
    "oauth_cc": "Client ID and client secret",
    "oauth_ac": "Client ID, client secret, and redirect configuration",
    "none": "No provider credential",
    "mandate": "Caracal-issued resource mandate",
}


def env_id(provider_id: str) -> str:
    return provider_id.upper().replace("-", "_")


def base_url(spec: partners.PartnerSpec) -> str:
    return os.environ.get(f"LYNX_PARTNER_{env_id(spec.id)}_URL", f"http://127.0.0.1:{spec.port}").rstrip("/")


def resource_bindings() -> dict[str, str]:
    bindings: dict[str, str] = {}
    for item in os.environ.get("CARACAL_RESOURCES", "").split(","):
        resource_id, separator, url = item.strip().partition("=")
        if separator and resource_id and url:
            bindings[resource_id.strip()] = url.strip()
    return bindings


def provider_entries(config_providers: list[Any]) -> list[dict[str, object]]:
    provider_config = {provider.id: provider for provider in config_providers}
    entries: list[dict[str, object]] = []
    resources = resource_bindings()
    for spec in partners.catalog().values():
        provider = provider_config.get(spec.id)
        url = base_url(spec)
        if spec.auth == "none":
            status = "Ready"
            resource = "Verified in process by Caracal"
        elif spec.auth == "mandate":
            status = "Mapped" if spec.id in resources else "Unmapped"
            resource = resources.get(spec.id, "Add to CARACAL_RESOURCES")
        elif spec.id in resources:
            status = "Mapped"
            resource = resources[spec.id]
        else:
            status = "Unmapped"
            resource = "Add to CARACAL_RESOURCES"
        credential_url = f"{url}/__lab/clients" if spec.auth.startswith("oauth") else f"{url}/__lab/credentials"
        entries.append({
            "id": spec.id,
            "name": provider.name if provider else spec.id.replace("-", " ").title(),
            "category": (provider.category if provider else "provider").replace("_", " ").title(),
            "auth": AUTH_LABELS.get(spec.auth, spec.auth.replace("_", " ").title()),
            "authType": provider.authType if provider else spec.auth,
            "protocol": (provider.protocol if provider else "http").upper(),
            "purpose": ", ".join(operation.replace("_", " ") for operation in spec.operations[:3]),
            "credentials": CREDENTIAL_REQUIREMENTS.get(spec.auth, spec.auth.replace("_", " ").title()),
            "resource": resource,
            "variables": [],
            "missing": [] if status != "Unmapped" else [spec.id],
            "upstreamUrl": url,
            "dashboardUrl": url,
            "credentialUrl": credential_url,
            "documentationUrl": f"{url}/__lab/resources",
            "status": status,
        })
    return entries
