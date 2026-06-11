"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Identity-model loader and Control provisioning-plan builders for the Lynx Capital swarm.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_TENANCY_PATH = ROOT / "config" / "tenancy.yaml"
DEFAULT_POLICIES_DIR = ROOT / "policies"
PROVISIONED_PATH = ROOT / "config" / "provisioned.json"
SCHEMA_VERSION = "2026-05-20"

# Every registered resource view carries this scope alongside its data scopes so the
# owning application can bootstrap its session mandate against the STS.
LIFECYCLE_SCOPE = "agent:lifecycle"

_ENV_PATTERN = re.compile(r"^\$\{([A-Z0-9_]+)(?::(.*))?\}$")


class ApplicationSpec(BaseModel):
    id: str
    applicationName: str
    description: str = ""


class ProviderSpec(BaseModel):
    id: str
    name: str
    kind: str
    port: int
    integrationView: str
    config: dict = {}
    scopes: dict[str, list[str]] = {}
    protocol: str = "rest"

    @property
    def identifier(self) -> str:
        return f"provider://{self.id}"

    def upstream_url(self) -> str:
        env = f"LYNX_PARTNER_{self.id.upper().replace('-', '_')}_URL"
        return os.environ.get(env, f"http://{self.id}.mock:{self.port}").rstrip("/")

    def operation_scope(self, operation: str) -> str | None:
        for scope, operations in self.scopes.items():
            if operation in operations:
                return scope
        return None

    def resolved_config(self, env: dict[str, str] | None = None) -> dict:
        """The provider config with ${ENV} and ${ENV:default} values substituted, in the
        exact shape the Control API validates for this provider kind. Token host
        allowlists are anchored to the provider's upstream URL so the gateway only sends
        the credential to the host the resource actually proxies to."""
        env = dict(os.environ) if env is None else env
        resolved: dict = {}
        for key, value in self.config.items():
            if isinstance(value, str):
                match = _ENV_PATTERN.match(value)
                if match:
                    name, default = match.group(1), match.group(2)
                    value = env.get(name, "") or (default or "")
                    if not value:
                        raise KeyError(f"provider {self.id}: config {key} requires env {name}")
            resolved[key] = value
        if self.kind == "bearer_token":
            resolved["allowed_token_hosts"] = [urlsplit(self.upstream_url()).hostname or ""]
        return resolved


class ResourceSpec(BaseModel):
    id: str
    identifier: str
    name: str
    application: str
    provider: str
    scopes: list[str]

    def registered_scopes(self) -> list[str]:
        return [*self.scopes, LIFECYCLE_SCOPE]


class RoleSpec(BaseModel):
    name: str
    application: str
    scopes: list[str] = []
    dynamic: bool = False


class PolicySetSpec(BaseModel):
    name: str
    description: str = ""
    schemaVersion: str = SCHEMA_VERSION


class TenancyModel(BaseModel):
    applications: list[ApplicationSpec]
    providers: list[ProviderSpec]
    resources: list[ResourceSpec]
    roles: list[RoleSpec]
    policySet: PolicySetSpec

    def application(self, key: str) -> ApplicationSpec:
        for spec in self.applications:
            if spec.id == key or spec.applicationName == key:
                return spec
        raise KeyError(f"unknown application: {key!r}")

    def provider(self, provider_id: str) -> ProviderSpec:
        for spec in self.providers:
            if spec.id == provider_id or spec.identifier == provider_id:
                return spec
        raise KeyError(f"unknown provider: {provider_id!r}")

    def resource(self, key: str) -> ResourceSpec:
        for spec in self.resources:
            if spec.id == key or spec.identifier == key:
                return spec
        raise KeyError(f"unknown resource: {key!r}")

    def role(self, name: str) -> RoleSpec:
        for spec in self.roles:
            if spec.name == name:
                return spec
        raise KeyError(f"unknown role: {name!r}")

    def application_resources(self, app_key: str) -> list[ResourceSpec]:
        return [r for r in self.resources if r.application == app_key]

    def view_for(self, app_key: str, provider_id: str, scope: str) -> ResourceSpec | None:
        """The application's resource view of a provider that exposes the scope."""
        for spec in self.resources:
            if spec.application == app_key and spec.provider == provider_id and scope in spec.scopes:
                return spec
        return None

    def integration_view(self, provider_id: str) -> ResourceSpec:
        """The view ad-hoc partner-integration workers operate through for a provider."""
        return self.resource(self.provider(provider_id).integrationView)


_model: TenancyModel | None = None


def load_model(path: str | os.PathLike[str] | None = None) -> TenancyModel:
    global _model
    if _model is not None and path is None:
        return _model
    target = Path(path) if path is not None else Path(os.environ.get("LYNX_TENANCY", DEFAULT_TENANCY_PATH))
    data = yaml.safe_load(target.read_text(encoding="utf-8"))
    model = TenancyModel.model_validate(data)
    _validate(model)
    if path is None:
        _model = model
    return model


def _validate(model: TenancyModel) -> None:
    apps = {a.id for a in model.applications}
    providers = {p.id for p in model.providers}
    views = {r.id for r in model.resources}
    for provider in model.providers:
        if provider.integrationView not in views:
            raise ValueError(f"provider {provider.id}: unknown integrationView {provider.integrationView!r}")
        seen: dict[str, str] = {}
        for scope, operations in provider.scopes.items():
            for operation in operations:
                if operation in seen:
                    raise ValueError(f"provider {provider.id}: operation {operation!r} mapped to both "
                                     f"{seen[operation]!r} and {scope!r}")
                seen[operation] = scope
    for resource in model.resources:
        if resource.application not in apps:
            raise ValueError(f"resource {resource.id}: unknown application {resource.application!r}")
        if resource.provider not in providers:
            raise ValueError(f"resource {resource.id}: unknown provider {resource.provider!r}")
        provider = model.provider(resource.provider)
        unknown = [s for s in resource.scopes if s not in provider.scopes]
        if unknown:
            raise ValueError(f"resource {resource.id}: scopes not in provider vocabulary: {unknown}")
    for role in model.roles:
        if role.application not in apps:
            raise ValueError(f"role {role.name}: unknown application {role.application!r}")
        for scope in role.scopes:
            if model.view_for(role.application, _scope_provider(model, scope), scope) is None:
                raise ValueError(f"role {role.name}: no {role.application} view exposes scope {scope!r}")


def _scope_provider(model: TenancyModel, scope: str) -> str:
    for provider in model.providers:
        if scope in provider.scopes:
            return provider.id
    raise ValueError(f"scope {scope!r} not declared by any provider")


def role_scopes(role: str, model: TenancyModel | None = None) -> list[str]:
    """The least-privilege scope set a role's delegation edge is narrowed to."""
    model = model or load_model()
    return list(model.role(role).scopes)


def role_application(role: str, model: TenancyModel | None = None) -> str:
    model = model or load_model()
    return model.role(role).application


def agent_labels(role: str, customer_id: str | None = None) -> list[str]:
    """The agent-session labels policy keys on: the role name, the swarm marker, and —
    when the work is for one customer — a customer label policy can enforce against."""
    labels = [role, "lynx-swarm"]
    if customer_id:
        labels.append(f"customer:{customer_id}")
    return labels


def agent_metadata(
    run_id: str,
    agent_id: str,
    scope: str,
    region: str | None = None,
    customer_id: str | None = None,
) -> dict[str, str]:
    """The spawn metadata that correlates an agent session to its run, local agent id,
    work item, and customer for the audit trail."""
    metadata = {"run_id": run_id, "agent_id": agent_id, "scope": scope}
    if region:
        metadata["region"] = region
    if customer_id:
        metadata["customer_id"] = customer_id
    return metadata


def operation_scope(provider_id: str, operation: str, model: TenancyModel | None = None) -> str | None:
    model = model or load_model()
    return model.provider(provider_id).operation_scope(operation)


def role_views(role: str, model: TenancyModel | None = None) -> list[str]:
    """The unique resource-view identifiers a role's scopes resolve to inside its
    application — the delegation constraint set for spawned workers."""
    model = model or load_model()
    spec = model.role(role)
    views = {
        view.identifier
        for scope in spec.scopes
        if (view := model.view_for(spec.application, _scope_provider(model, scope), scope))
    }
    return sorted(views)


def partnership_manifest(model: TenancyModel | None = None) -> dict[str, dict]:
    """The partnership terms each mandate-verifying provider is configured with: the
    resource-view audiences it serves with the scopes each view exposes, and the
    Caracal scope-to-operation grants it honors, in the shape the provider lab's
    LYNX_CARACAL_PARTNERSHIP expects."""
    model = model or load_model()
    return {
        provider.id: {
            "audiences": {
                r.identifier: sorted(r.scopes)
                for r in model.resources
                if r.provider == provider.id
            },
            "scopes": provider.scopes,
        }
        for provider in model.providers
        if provider.kind == "caracal_mandate"
    }


def partner_plan(provider_id: str, operation: str, model: TenancyModel | None = None) -> tuple[str, str, str] | None:
    """The (application, scope, view identifier) a dynamic partner-integration worker
    needs for one provider operation, or None when the operation maps to no view."""
    model = model or load_model()
    try:
        provider = model.provider(provider_id)
    except KeyError:
        return None
    scope = provider.operation_scope(operation)
    if scope is None:
        return None
    view = model.integration_view(provider.id)
    if scope not in view.scopes:
        return None
    return view.application, scope, view.identifier


def load_provisioned() -> dict:
    if PROVISIONED_PATH.exists():
        return json.loads(PROVISIONED_PATH.read_text(encoding="utf-8"))
    return {}


# --------------------------------------------------------------------------- #
# Control provisioning-plan builders
# --------------------------------------------------------------------------- #
def application_commands(model: TenancyModel) -> list[dict]:
    """Control invoke payloads that create each managed application boundary."""
    return [
        {"command": "app", "subcommand": "create", "flags": {"name": app.applicationName}}
        for app in model.applications
    ]


def provider_commands(model: TenancyModel, env: dict[str, str] | None = None) -> list[dict]:
    """Control invoke payloads that register each partner credential provider in the
    exact config shape its kind supports."""
    return [
        {
            "command": "identity-provider",
            "subcommand": "create",
            "flags": {
                "name": provider.name,
                "identifier": provider.identifier,
                "kind": provider.kind,
                "config": json.dumps(provider.resolved_config(env)),
            },
        }
        for provider in model.providers
    ]


def resource_commands(
    model: TenancyModel,
    provider_ids: dict[str, str],
    application_ids: dict[str, str],
) -> list[dict]:
    """Control invoke payloads that register every per-application resource view and bind
    it to its credential provider and its one gateway application."""
    commands: list[dict] = []
    for resource in model.resources:
        provider = model.provider(resource.provider)
        commands.append({
            "command": "resource",
            "subcommand": "create",
            "flags": {
                "name": resource.name,
                "identifier": resource.identifier,
                "scopes": resource.registered_scopes(),
                "upstream-url": provider.upstream_url(),
                "credential-provider-id": provider_ids[provider.identifier],
                "gateway-application-id": application_ids[resource.application],
            },
        })
    return commands


def _rego_strings(values: list[str]) -> str:
    return "[" + ", ".join(f'"{v}"' for v in values) + "]"


def _rego_grants(grants: dict[str, dict]) -> str:
    """Render the grants map as canonical opa-fmt Rego: tab indentation, trailing
    commas in multiline composites, single-entry composites inline."""
    lines = ["grants := {"]
    for identifier in sorted(grants):
        entry = grants[identifier]
        lines.append(f'\t"{identifier}": {{')
        lines.append(f'\t\t"application": "{entry["application"]}",')
        roles = entry["roles"]
        if len(roles) == 1:
            ((role, scopes),) = roles.items()
            lines.append(f'\t\t"roles": {{"{role}": {_rego_strings(scopes)}}},')
        else:
            lines.append('\t\t"roles": {')
            for role in sorted(roles):
                lines.append(f'\t\t\t"{role}": {_rego_strings(roles[role])},')
            lines.append("\t\t},")
        lines.append("\t},")
    lines.append("}")
    return "\n".join(lines)


def render_grants_rego(model: TenancyModel | None = None) -> str:
    """The generated grants data document: every resource view, its owning application,
    and the scope set each role may hold on it. Single source for policy decisions."""
    model = model or load_model()
    grants: dict[str, dict] = {}
    for resource in model.resources:
        roles: dict[str, list[str]] = {}
        for role in model.roles:
            if role.application != resource.application:
                continue
            scopes = sorted(set(role.scopes) & set(resource.scopes))
            if scopes:
                roles[role.name] = scopes
        integration = model.integration_view(resource.provider)
        if integration.id == resource.id:
            roles["partner-integration"] = sorted(resource.scopes)
        grants[resource.identifier] = {"application": resource.application, "roles": roles}
    return (
        '# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.\n'
        '# Caracal, a product of Garudex Labs\n'
        '#\n'
        '# Generated grants data: resource views, owning applications, and role scope sets.\n'
        '# Rendered by app.tenancy.render_grants_rego from config/tenancy.yaml; do not edit.\n'
        'package caracal.authz\n\n'
        'import rego.v1\n\n'
        f'{_rego_grants(grants)}\n\n'
        '# Grants are data for the shared rules in 00-base; this document never decides on\n'
        '# its own. The inert rule below satisfies the platform\'s policy authoring contract,\n'
        '# which requires every authored policy to define a result rule.\n'
        'result := allow_result("lynx-grants") if {\n'
        '\tfalse\n'
        '}\n'
    )


def render_bindings_rego(application_ids: dict[str, str]) -> str:
    """The bindings data document mapping application keys to the control-plane UUIDs
    OPA sees as input.principal.id. Rendered with real ids at provision time."""
    rows = "\n".join(
        f'\t"{key}": "{application_ids[key]}",' for key in sorted(application_ids)
    )
    body = "{\n" + rows + "\n}"
    return (
        '# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.\n'
        '# Caracal, a product of Garudex Labs\n'
        '#\n'
        '# Application bindings: the control-plane application ids each policy keys on.\n'
        '# Rendered by scripts/provision.py from the created applications; do not edit.\n'
        'package caracal.authz\n\n'
        'import rego.v1\n\n'
        f'app_ids := {body}\n\n'
        '# Bindings are data for the shared rules in 00-base; this document never decides on\n'
        '# its own. The inert rule below satisfies the platform\'s policy authoring contract,\n'
        '# which requires every authored policy to define a result rule.\n'
        'result := allow_result("lynx-bindings") if {\n'
        '\tfalse\n'
        '}\n'
    )


def policy_files(
    policies_dir: str | os.PathLike[str] | None = None,
    overrides: dict[str, str] | None = None,
) -> list[tuple[str, str]]:
    """The policy library as ordered (name, content) pairs, 00-base first. `overrides`
    replaces a file's content by stem (used to author real bindings at provision time)."""
    directory = Path(policies_dir) if policies_dir is not None else DEFAULT_POLICIES_DIR
    overrides = overrides or {}
    files = sorted(p for p in directory.glob("*.rego") if not p.name.endswith("_test.rego"))
    return [(p.stem, overrides.get(p.stem, p.read_text(encoding="utf-8"))) for p in files]


def policy_commands(
    model: TenancyModel,
    policies_dir: str | os.PathLike[str] | None = None,
    overrides: dict[str, str] | None = None,
) -> list[dict]:
    """Control invoke payloads that author every policy in the library."""
    return [
        {
            "command": "policy",
            "subcommand": "create",
            "flags": {"name": name, "content": content, "schema-version": model.policySet.schemaVersion},
        }
        for name, content in policy_files(policies_dir, overrides)
    ]
