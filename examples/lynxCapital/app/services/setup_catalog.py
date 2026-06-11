"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Setup catalog helpers that join the partner catalog with the tenancy identity model and the provisioned control-plane state.
"""
from __future__ import annotations

import re
from typing import Any

from app import tenancy
from app.services import partners

KIND_LABELS = {
    "api_key": "API key",
    "bearer_token": "Bearer token",
    "oauth2_client_credentials": "OAuth client credentials",
    "oauth2_authorization_code": "OAuth authorization code",
    "none": "No credential",
    "caracal_mandate": "Caracal mandate",
}

CREDENTIAL_REQUIREMENTS = {
    "api_key": "API key",
    "bearer_token": "Bearer token",
    "oauth2_client_credentials": "Client ID and client secret",
    "oauth2_authorization_code": "Client ID, client secret, and redirect configuration",
    "none": "No provider credential",
    "caracal_mandate": "None — the Gateway forwards the agent's Caracal mandate",
}

_ENV_REF = re.compile(r"\$\{([A-Z0-9_]+)(?::[^}]*)?\}")


def provisioned_state() -> tuple[dict[str, str], set[str]]:
    """The provider identifier map and resource identifier set recorded by provision.py."""
    recorded = tenancy.load_provisioned()
    providers = recorded.get("providers", {})
    resources = set(recorded.get("resources", []))
    return (providers if isinstance(providers, dict) else {}), resources


def config_env_refs(provider: tenancy.ProviderSpec) -> list[str]:
    """The operator env vars a provider's config references, without defaults applied."""
    refs: list[str] = []
    for value in provider.config.values():
        if isinstance(value, str):
            for match in _ENV_REF.finditer(value):
                if match.group(1) not in refs:
                    refs.append(match.group(1))
    return refs


def provider_entries(config_providers: list[Any]) -> list[dict[str, object]]:
    """One setup card per partner provider: its Caracal provider kind and config, the
    per-application resource views the Gateway binds for it, and its provisioned state."""
    display = {provider.id: provider for provider in config_providers}
    model = tenancy.load_model()
    provisioned_providers, provisioned_resources = provisioned_state()
    entries: list[dict[str, object]] = []
    for spec in partners.catalog().values():
        provider = model.provider(spec.id)
        meta = display.get(spec.id)
        url = provider.upstream_url()
        views = [r for r in model.resources if r.provider == spec.id]
        views_ready = [v for v in views if v.identifier in provisioned_resources]
        registered = provider.identifier in provisioned_providers
        if registered and len(views_ready) == len(views):
            status = "Provisioned"
        elif registered:
            status = "Partial"
        else:
            status = "Unprovisioned"
        credential_url = (
            f"{url}/__lab/clients" if provider.kind.startswith("oauth2") else f"{url}/__lab/credentials"
        )
        entries.append({
            "id": spec.id,
            "name": meta.name if meta else provider.name,
            "category": (meta.category if meta else "provider").replace("_", " ").title(),
            "auth": KIND_LABELS.get(provider.kind, provider.kind),
            "authType": meta.authType if meta else provider.kind,
            "protocol": (meta.protocol if meta else provider.protocol).upper(),
            "purpose": ", ".join(operation.replace("_", " ") for operation in spec.operations[:3]),
            "credentials": CREDENTIAL_REQUIREMENTS.get(provider.kind, provider.kind),
            "kind": provider.kind,
            "providerIdentifier": provider.identifier,
            "scopes": " ".join(sorted(provider.scopes)),
            "views": [
                {"identifier": v.identifier, "application": v.application,
                 "scopes": " ".join(v.scopes),
                 "ready": v.identifier in provisioned_resources}
                for v in views
            ],
            "configEnv": config_env_refs(provider),
            "external": provider.kind != "none",
            "upstreamUrl": url,
            "dashboardUrl": url,
            "credentialUrl": credential_url,
            "documentationUrl": f"{url}/__lab/resources",
            "status": status,
        })
    return entries
