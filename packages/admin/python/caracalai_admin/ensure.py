"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Idempotent reconcilers that converge applications, providers, resources, and policy sets to a desired state.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from .client import AdminClient

LIFECYCLE_SCOPE = "agent:lifecycle"

GRANT_POLICY_NAME = "application-grants"
GRANT_POLICY_SET_NAME = "application-grant-policy"

_UNSET: Any = object()


def _same_string_set(live: Sequence[str] | None, desired: Sequence[str]) -> bool:
    have = set(live or [])
    return len(have) == len(desired) and all(value in have for value in desired)


def _sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def ensure_application(
    client: AdminClient,
    zone_id: str,
    *,
    name: str,
    traits: list[str],
    client_secret: str,
) -> str:
    """Converges a managed application to exactly the given trait set and
    seals the given client secret, creating it when absent. The secret patch
    on every run is the rotation itself: the previous secret stops working the
    moment the new one is sealed, which is also how a compromised credential
    is revoked. An existing same-named identity must be a usable managed
    credential; a DCR or app-expiring application cannot carry a rotating
    secret, so binding to it would report the identity configured while every
    token mint failed. Fails closed instead, so the misconfiguration surfaces
    rather than hiding. Returns the application id."""
    apps = client.applications.list(zone_id)
    existing = next((app for app in apps if app["name"] == name), None)
    if existing is None:
        created = client.applications.create(
            zone_id, {"name": name, "registration_method": "managed", "traits": traits}
        )
        client.applications.patch(
            zone_id, created["id"], {"client_secret": client_secret}
        )
        return created["id"]
    if (
        existing.get("registration_method") != "managed"
        or existing.get("expires_at") is not None
    ):
        raise RuntimeError(
            f"application {name} exists but is not a usable managed credential"
        )
    if not _same_string_set(existing.get("traits"), traits):
        client.applications.patch(zone_id, existing["id"], {"traits": traits})
    client.applications.patch(zone_id, existing["id"], {"client_secret": client_secret})
    return existing["id"]


def ensure_api_key_provider(
    client: AdminClient,
    zone_id: str,
    *,
    name: str,
    identifier: str,
    public_config: dict[str, Any],
    api_key: str | None = None,
) -> str | None:
    """Seals an api key into an api_key provider the gateway injects at call
    time, so the caller never holds the key. When a key is supplied it is
    reconciled together with the public placement config (the sealed secret
    cannot be read back, so setting or rotating re-seals). When no key is
    supplied but the placement may have changed, the existing provider's
    public config is patched without resupplying the key, so an edit applies
    and the sealed secret is preserved. A missing provider with no key returns
    None, marking the credential unconfigured so no resource binds a dead
    credential."""
    providers = client.providers.list(zone_id)
    existing = next(
        (provider for provider in providers if provider["identifier"] == identifier),
        None,
    )
    if api_key is None:
        if existing is None:
            return None
        client.providers.patch(zone_id, existing["id"], {"config_json": public_config})
        return existing["id"]
    config = {**public_config, "api_key": api_key}
    if existing is None:
        created = client.providers.create(
            zone_id,
            {
                "name": name,
                "identifier": identifier,
                "kind": "api_key",
                "config_json": config,
            },
        )
        return created["id"]
    client.providers.patch(
        zone_id, existing["id"], {"kind": "api_key", "config_json": config}
    )
    return existing["id"]


def ensure_resource(
    client: AdminClient,
    zone_id: str,
    *,
    name: str,
    identifier: str,
    scopes: list[str],
    upstream_url: str | None = _UNSET,
    credential_provider_id: str | None = _UNSET,
    gateway_application_id: str | None = _UNSET,
    operation_enforcement: str = _UNSET,
) -> Any:
    """Converges a resource to the given desired fields, creating it when
    absent and patching it only on drift so a steady state never bumps caches
    keyed on the resource row. Fields left unset are not managed: they are
    excluded from both the drift comparison and the patch, so a reconciler
    that owns only some fields never clobbers the rest. A gateway-bound
    resource always also carries agent:lifecycle, the scope its owner's
    governed transport bootstraps with. Returns the live resource."""
    desired_scopes = scopes
    if (
        gateway_application_id is not _UNSET
        and gateway_application_id
        and LIFECYCLE_SCOPE not in scopes
    ):
        desired_scopes = [*scopes, LIFECYCLE_SCOPE]
    desired: dict[str, Any] = {"scopes": desired_scopes}
    if upstream_url is not _UNSET:
        desired["upstream_url"] = upstream_url
    if credential_provider_id is not _UNSET:
        desired["credential_provider_id"] = credential_provider_id
    if gateway_application_id is not _UNSET:
        desired["gateway_application_id"] = gateway_application_id
    if operation_enforcement is not _UNSET:
        desired["operation_enforcement"] = operation_enforcement
    resources = client.resources.list(zone_id)
    existing = next(
        (resource for resource in resources if resource["identifier"] == identifier),
        None,
    )
    if existing is None:
        return client.resources.create(
            zone_id, {"name": name, "identifier": identifier, **desired}
        )
    drifted = not _same_string_set(existing.get("scopes"), desired_scopes) or any(
        key in desired and existing.get(key) != desired[key]
        for key in (
            "upstream_url",
            "credential_provider_id",
            "gateway_application_id",
            "operation_enforcement",
        )
    )
    if not drifted:
        return existing
    return client.resources.patch(zone_id, existing["id"], desired)


def ensure_active_policy_set(
    client: AdminClient,
    zone_id: str,
    *,
    policy_name: str,
    set_name: str,
    content: str,
    create_when_missing: bool = True,
) -> None:
    """Converges one named policy and policy set to carry exactly the given
    content, active. Policy versions are immutable, so a new version is added
    only when the content's digest changes; the set is re-activated only when
    the content changed or no version is active, which self-heals a
    deactivated set without churning a steady state. When create_when_missing
    is False and no policy with policy_name exists yet, nothing is created: an
    empty desired state materializes no artifacts."""
    policies = client.policies.list(zone_id)
    policy = next((entry for entry in policies if entry["name"] == policy_name), None)
    if policy is None and not create_when_missing:
        return

    desired_sha = _sha256_hex(content)
    if policy is None:
        created = client.policies.create(
            zone_id, {"name": policy_name, "content": content}
        )
        policy_version_id = created["version_id"]
        policy_changed = True
    else:
        detail = client.policies.get(zone_id, policy["id"])
        latest = max(detail["versions"], key=lambda version: version["version"])
        if latest["content_sha256"] == desired_sha:
            policy_version_id = latest["id"]
            policy_changed = False
        else:
            added = client.policies.add_version(zone_id, policy["id"], content)
            policy_version_id = added["version_id"]
            policy_changed = True

    sets = client.policy_sets.list(zone_id)
    policy_set = next((entry for entry in sets if entry["name"] == set_name), None)
    if policy_set is None:
        policy_set = client.policy_sets.create(zone_id, set_name)
    if policy_changed or not policy_set.get("active_version_id"):
        version = client.policy_sets.add_version(
            zone_id, policy_set["id"], [{"policy_version_id": policy_version_id}]
        )
        client.policy_sets.activate(zone_id, policy_set["id"], version["version_id"])


@dataclass(frozen=True)
class ResourceGrant:
    """One data-plane grant: the application may mint the given scopes on the
    resource. role is the agent label the zone's decision contract matches at
    mint and use time; it defaults to the application id, the same default
    label the SDK's governed transport spawns with, so a grant and its
    transport align without either naming a role. The first grant for a
    resource names its owning application - the identity whose governed
    transport may bootstrap on it; later grants for the same resource add
    roles only."""

    application_id: str
    resource_identifier: str
    scopes: list[str] = field(default_factory=list)
    role: str | None = None


def _canonical_json(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def author_grants_document(grants: Sequence[ResourceGrant]) -> str:
    """Authors the zone's grant data document: the platform decision contract
    reads app_ids and grants to authorize data-plane exchanges, and this
    renders them so no caller ever touches the document format. Deterministic
    - roles, resources, and scopes are sorted and rendered as canonical JSON -
    so an unchanged grant set produces an identical document and the
    reconciler adds no new policy version."""
    app_ids: dict[str, str] = {}
    by_resource: dict[str, dict[str, Any]] = {}
    for grant in grants:
        role = grant.role if grant.role is not None else grant.application_id
        if role in app_ids and app_ids[role] != grant.application_id:
            raise ValueError(f"grant role '{role}' is claimed by two applications")
        app_ids[role] = grant.application_id
        entry = by_resource.setdefault(
            grant.resource_identifier, {"application": role, "roles": {}}
        )
        entry["roles"][role] = sorted(
            set(entry["roles"].get(role, [])) | set(grant.scopes)
        )
    sorted_app_ids = {role: app_ids[role] for role in sorted(app_ids)}
    sorted_grants: dict[str, Any] = {}
    for identifier in sorted(by_resource):
        entry = by_resource[identifier]
        roles = {role: entry["roles"][role] for role in sorted(entry["roles"])}
        sorted_grants[identifier] = {
            "application": entry["application"],
            "roles": roles,
        }
    return "\n".join(
        [
            "# caracal:data-document",
            "package caracal.authz",
            "import rego.v1",
            f"app_ids := {_canonical_json(sorted_app_ids)}",
            f"grants := {_canonical_json(sorted_grants)}",
            "",
        ]
    )


def ensure_grants(
    client: AdminClient,
    zone_id: str,
    *,
    grants: Sequence[ResourceGrant],
    policy_name: str | None = None,
    set_name: str | None = None,
) -> None:
    """Converges the zone's grant policy so each application may mint exactly
    the given scopes on its resources. This owns the decision-contract
    data-document format end to end: pair it with ensure_resource and a
    governed transport and an application's authority is fully declared
    without authoring policy text. With an empty grant set and no existing
    policy it creates nothing; with an existing policy it converges the
    document to the (possibly empty) set, revoking what is no longer
    granted."""
    ensure_active_policy_set(
        client,
        zone_id,
        policy_name=policy_name if policy_name is not None else GRANT_POLICY_NAME,
        set_name=set_name if set_name is not None else GRANT_POLICY_SET_NAME,
        content=author_grants_document(list(grants)),
        create_when_missing=len(grants) > 0,
    )
