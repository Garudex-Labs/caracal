"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Removes the Lynx Capital deployment through the Control API: the policy set, the policies,
the resource views, the partner credential providers, and the application boundaries.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import tenancy
from control_client import ControlClient, config_from_env, find_by_identifier, find_by_name


def remove(client: ControlClient, command: str, item: dict | None, label: str) -> None:
    if not item or not item.get("id"):
        return
    client.invoke(command, "delete", {"id": item["id"]})
    print(f"{label} removed: {item.get('identifier') or item.get('name')}")


def main() -> None:
    model = tenancy.load_model()
    client = ControlClient(config_from_env())

    remove(client, "policy-set", find_by_name(client.invoke("policy-set", "list"), model.policySet.name), "policy-set")

    policy_list = client.invoke("policy", "list")
    for name, _ in tenancy.policy_files():
        remove(client, "policy", find_by_name(policy_list, name), "policy")

    resource_list = client.invoke("resource", "list")
    for resource in model.resources:
        remove(client, "resource", find_by_identifier(resource_list, resource.identifier), "resource")

    provider_list = client.invoke("identity-provider", "list")
    for provider in model.providers:
        remove(client, "identity-provider", find_by_identifier(provider_list, provider.identifier), "provider")

    app_list = client.invoke("app", "list")
    for app in model.applications:
        remove(client, "app", find_by_name(app_list, app.applicationName), "application")

    print(
        f"removed the {model.policySet.name} policy set, {len(model.resources)} resource views, "
        f"{len(model.providers)} providers, and {len(model.applications)} applications"
    )


if __name__ == "__main__":
    main()
