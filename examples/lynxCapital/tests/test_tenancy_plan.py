"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the Lynx Capital identity model and Control provisioning-plan builders.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import tenancy
from app.services import partners, setup_catalog

POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"


def _stub_env(model: tenancy.TenancyModel) -> dict[str, str]:
    env: dict[str, str] = {}
    for provider in model.providers:
        for name in setup_catalog.config_env_refs(provider):
            env[name] = f"https://stub.lynx.test/{name.lower()}"
    return env


def test_model_loads_the_full_boundary_plan():
    model = tenancy.load_model()
    assert {a.applicationName for a in model.applications} == {
        "lynx-operations", "lynx-intake", "lynx-ledger", "lynx-compliance",
        "lynx-treasury", "lynx-payments", "lynx-audit",
    }
    assert len(model.providers) == 20
    assert len(model.resources) == 32
    assert len(model.roles) == 17
    assert model.policySet.name == "lynx-finance-ops"


def test_providers_cover_the_partner_catalog_with_supported_kinds():
    model = tenancy.load_model()
    assert {p.id for p in model.providers} == set(partners.catalog())
    kinds = {p.kind for p in model.providers}
    assert kinds == {
        "api_key", "bearer_token", "oauth2_client_credentials",
        "oauth2_authorization_code", "caracal_mandate", "none",
    }
    for provider in model.providers:
        assert provider.identifier == f"provider://{provider.id}"


def test_provider_scope_vocabulary_stays_inside_the_partner_surface():
    """Every scoped operation is real, and operations left out of the vocabulary are
    deliberately unreachable through the Gateway — least privilege by omission."""
    model = tenancy.load_model()
    for spec in partners.catalog().values():
        provider = model.provider(spec.id)
        declared = {op for ops in provider.scopes.values() for op in ops}
        assert declared <= set(spec.operations), spec.id
        assert declared, spec.id


def test_every_resource_view_binds_one_application_inside_the_provider_vocabulary():
    model = tenancy.load_model()
    apps = {a.id for a in model.applications}
    for view in model.resources:
        assert view.application in apps
        provider = model.provider(view.provider)
        assert set(view.scopes) <= set(provider.scopes)
        assert view.identifier == f"resource://{view.id}"
    for app in model.applications:
        assert model.application_resources(app.id), app.id


def test_role_grants_resolve_to_views_in_their_own_application():
    model = tenancy.load_model()
    for role in model.roles:
        if role.dynamic:
            assert role.scopes == []
            continue
        if not role.scopes:
            continue
        views = tenancy.role_views(role.name, model)
        assert views, role.name
        for identifier in views:
            assert model.resource(identifier).application == role.application


def test_partner_plan_resolves_only_through_the_integration_view():
    plan = tenancy.partner_plan("meridian-pay", "list_charges")
    assert plan == ("audit", "meridian:read", "resource://audit-meridian")
    # The integration view is read-only for this partner, so a payout operation
    # cannot be reached through ad-hoc partner integration.
    assert tenancy.partner_plan("meridian-pay", "create_payout") is None
    assert tenancy.partner_plan("meridian-pay", "no_such_op") is None
    assert tenancy.partner_plan("no-such-provider", "list_charges") is None


def test_application_commands_create_every_boundary():
    model = tenancy.load_model()
    apps = tenancy.application_commands(model)
    assert {c["flags"]["name"] for c in apps} == {a.applicationName for a in model.applications}
    assert all(c["command"] == "app" and c["subcommand"] == "create" for c in apps)


def test_provider_commands_register_exact_kind_configs():
    model = tenancy.load_model()
    commands = tenancy.provider_commands(model, env=_stub_env(model))
    assert {c["flags"]["identifier"] for c in commands} == {p.identifier for p in model.providers}
    for command in commands:
        provider = model.provider(command["flags"]["identifier"])
        config = json.loads(command["flags"]["config"])
        assert command["flags"]["kind"] == provider.kind
        if provider.kind == "api_key":
            assert "api_key" in config
            assert config["auth_location"] in {"header", "query"}
            if config["auth_location"] == "header":
                assert "header_name" in config
            else:
                assert "query_param_name" in config
        elif provider.kind == "bearer_token":
            assert "bearer_token" in config
            assert config["allowed_token_hosts"]
        elif provider.kind == "oauth2_client_credentials":
            assert {"client_id", "client_secret", "token_endpoint"} <= set(config)
            assert config["token_endpoint"].startswith("https://")
        elif provider.kind == "oauth2_authorization_code":
            assert {"client_id", "client_secret", "authorization_endpoint", "token_endpoint"} <= set(config)
            assert config["token_endpoint"].startswith("https://")
        else:
            assert config == {}


def test_provider_commands_fail_closed_on_missing_credential_env():
    model = tenancy.load_model()
    with pytest.raises(KeyError):
        tenancy.provider_commands(model, env={})


def test_resource_commands_bind_provider_and_gateway_application():
    model = tenancy.load_model()
    provider_ids = {p.identifier: f"cp_{p.id}" for p in model.providers}
    application_ids = {a.id: f"app_{a.id}" for a in model.applications}
    commands = tenancy.resource_commands(model, provider_ids, application_ids)
    assert {c["flags"]["identifier"] for c in commands} == {r.identifier for r in model.resources}
    for command in commands:
        view = model.resource(command["flags"]["identifier"])
        assert command["flags"]["credential-provider-id"] == f"cp_{view.provider}"
        assert command["flags"]["gateway-application-id"] == f"app_{view.application}"
        assert tenancy.LIFECYCLE_SCOPE in command["flags"]["scopes"]
        assert set(view.scopes) <= set(command["flags"]["scopes"])


def test_policy_commands_cover_the_library_base_first():
    model = tenancy.load_model()
    commands = tenancy.policy_commands(model)
    names = [c["flags"]["name"] for c in commands]
    manifest = json.loads((POLICIES_DIR / "manifest.json").read_text(encoding="utf-8"))
    assert names == manifest["policies"]
    assert names[0] == "00-base"
    assert all("package caracal.authz" in c["flags"]["content"] for c in commands)
    assert all(c["flags"]["schema-version"] == model.policySet.schemaVersion for c in commands)


def test_generated_grants_document_is_fresh():
    rendered = tenancy.render_grants_rego()
    checked_in = (POLICIES_DIR / "02-grants.rego").read_text(encoding="utf-8")
    assert rendered == checked_in, (
        "policies/02-grants.rego is stale; regenerate it with app.tenancy.render_grants_rego()"
    )


def test_bindings_render_carries_application_ids():
    rendered = tenancy.render_bindings_rego({"operations": "0193a000-aaaa-7000-8000-000000000001"})
    assert "app_ids :=" in rendered
    assert "0193a000-aaaa-7000-8000-000000000001" in rendered
    assert "package caracal.authz" in rendered


def test_agent_labels_and_metadata_identify_the_agent():
    assert tenancy.agent_labels("payment-execution") == ["payment-execution", "lynx-swarm"]
    metadata = tenancy.agent_metadata("run-1", "agent-9", "payments.us", "US")
    assert metadata == {"run_id": "run-1", "agent_id": "agent-9", "scope": "payments.us", "region": "US"}
    assert "region" not in tenancy.agent_metadata("run-1", "agent-9", "payments.us")
