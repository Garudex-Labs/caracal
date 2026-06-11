"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Provisions the Lynx Capital deployment through the Control API: the application
boundaries, partner credential providers, per-application resource views, and the policy
library plus its active policy set.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import tenancy
from control_client import (
    ControlClient,
    ControlError,
    config_from_env,
    find_by_identifier,
    find_by_name,
)

ROOT = Path(__file__).resolve().parent.parent
OUTPUTS_PATH = ROOT / "config" / "provisioned.json"


def _id_of(result: object) -> str:
    if not isinstance(result, dict) or not result.get("id"):
        raise ControlError(f"control response missing id: {result!r}")
    return str(result["id"])


def _version_id(result: object) -> str:
    if not isinstance(result, dict) or not result.get("version_id"):
        raise ControlError(f"control response missing version_id: {result!r}")
    return str(result["version_id"])


def ensure_applications(client: ControlClient, model: tenancy.TenancyModel) -> dict[str, str]:
    """Create each managed application boundary, returning a map of application key to
    the control-plane id. The create response carries the client secret exactly once;
    it is printed as the runtime export and never written to disk."""
    existing = client.invoke("app", "list")
    application_ids: dict[str, str] = {}
    for app in model.applications:
        found = find_by_name(existing, app.applicationName)
        result = found if found else client.invoke("app", "create", {"name": app.applicationName})
        print(f"application {'exists' if found else 'created'}: {app.applicationName}")
        application_ids[app.id] = _id_of(result)
        env_key = app.id.upper().replace("-", "_")
        if not found and isinstance(result, dict) and result.get("client_secret"):
            print(f"  export LYNX_CARACAL_{env_key}_CLIENT_SECRET={result['client_secret']}")
        print(f"  export LYNX_CARACAL_{env_key}_APPLICATION_ID={application_ids[app.id]}")
    return application_ids


def ensure_providers(client: ControlClient, model: tenancy.TenancyModel) -> dict[str, str]:
    """Register each upstream credential provider, returning a map of provider identifier to
    the control-plane id so resources can bind to it. Existing providers are patched so
    config changes (endpoints, credentials, token host allowlists) reconcile on re-run."""
    existing = client.invoke("identity-provider", "list")
    provider_ids: dict[str, str] = {}
    for command in tenancy.provider_commands(model):
        identifier = command["flags"]["identifier"]
        found = find_by_identifier(existing, identifier)
        if found:
            client.invoke("identity-provider", "patch", {
                "id": _id_of(found),
                "kind": command["flags"]["kind"],
                "config": command["flags"]["config"],
            })
            result = found
            print(f"provider patched: {identifier}")
        else:
            result = client.run(command)
            print(f"provider created: {identifier}")
        provider_ids[identifier] = _id_of(result)
    return provider_ids


def ensure_resources(
    client: ControlClient,
    model: tenancy.TenancyModel,
    provider_ids: dict[str, str],
    application_ids: dict[str, str],
) -> None:
    """Create each per-application resource view. Existing views are patched so upstream
    URLs, scopes, and bindings reconcile on re-run."""
    existing = client.invoke("resource", "list")
    for command in tenancy.resource_commands(model, provider_ids, application_ids):
        identifier = command["flags"]["identifier"]
        found = find_by_identifier(existing, identifier)
        if found:
            client.invoke("resource", "patch", {
                "id": _id_of(found),
                "scopes": command["flags"]["scopes"],
                "upstream-url": command["flags"]["upstream-url"],
                "credential-provider-id": command["flags"]["credential-provider-id"],
                "gateway-application-id": command["flags"]["gateway-application-id"],
            })
            print(f"resource patched: {identifier}")
            continue
        client.run(command)
        print(f"resource created: {identifier}")


def ensure_policy_set(client: ControlClient, model: tenancy.TenancyModel, application_ids: dict[str, str]) -> None:
    """Author the policy library with the bindings and grants documents rendered from the
    live application ids and tenancy plan, then version and activate the policy set."""
    overrides = {
        "01-bindings": tenancy.render_bindings_rego(application_ids),
        "02-grants": tenancy.render_grants_rego(model),
    }
    existing_policies = client.invoke("policy", "list")
    version_ids: list[str] = []
    for command in tenancy.policy_commands(model, overrides=overrides):
        name = command["flags"]["name"]
        found = find_by_name(existing_policies, name)
        if found:
            result = client.invoke("policy", "version", {
                "id": found["id"],
                "content": command["flags"]["content"],
                "schema-version": command["flags"]["schema-version"],
            })
            print(f"policy versioned: {name}")
        else:
            result = client.run(command)
            print(f"policy created: {name}")
        version_ids.append(_version_id(result))

    set_name = model.policySet.name
    existing_set = find_by_name(client.invoke("policy-set", "list"), set_name)
    if existing_set:
        set_id = existing_set.get("id")
        print(f"policy-set exists: {set_name}")
    else:
        created = client.invoke("policy-set", "create", {
            "name": set_name,
            "description": model.policySet.description,
        })
        set_id = _id_of(created)
        print(f"policy-set created: {set_name}")

    if not version_ids:
        print("policy-set: no policy version ids returned; author versions and activate in Console")
        return
    version = client.invoke("policy-set", "version", {
        "id": set_id,
        "policy-versions": ",".join(version_ids),
    })
    set_version_id = _version_id(version)
    client.invoke("policy-set", "activate", {"id": set_id, "version": set_version_id})
    print(f"policy-set activated: {set_name} ({set_version_id})")


def write_outputs(
    application_ids: dict[str, str],
    provider_ids: dict[str, str],
    model: tenancy.TenancyModel,
) -> None:
    outputs = {
        "applications": {
            a.id: {"name": a.applicationName, "application_id": application_ids.get(a.id, "")}
            for a in model.applications
        },
        "providers": provider_ids,
        "resources": [r.identifier for r in model.resources],
        "policy_set": model.policySet.name,
    }
    OUTPUTS_PATH.write_text(json.dumps(outputs, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {OUTPUTS_PATH.relative_to(ROOT)}")


def main() -> None:
    model = tenancy.load_model()
    client = ControlClient(config_from_env())
    application_ids = ensure_applications(client, model)
    provider_ids = ensure_providers(client, model)
    ensure_resources(client, model, provider_ids, application_ids)
    ensure_policy_set(client, model, application_ids)
    write_outputs(application_ids, provider_ids, model)
    terms = json.dumps(tenancy.partnership_manifest(model), separators=(",", ":"))
    print("partnership terms for the mandate-verifying providers (export before starting the provider lab):")
    print(f"  export LYNX_CARACAL_PARTNERSHIP='{terms}'")
    print(
        f"provisioned {len(model.applications)} applications, {len(model.providers)} providers, "
        f"{len(model.resources)} resource views, and the {model.policySet.name} policy set"
    )


if __name__ == "__main__":
    main()
