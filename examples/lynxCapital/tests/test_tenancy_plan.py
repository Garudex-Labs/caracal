"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the Lynx Capital identity model and Control provisioning-plan builders.
"""
from __future__ import annotations

from app import tenancy


def test_model_and_manifest_load():
    model = tenancy.load_model()
    assert {a.id for a in model.applications} == {"portfolio", "research", "compliance"}
    assert {a.applicationName for a in model.applications} == {
        "lynx-portfolio",
        "lynx-research",
        "lynx-compliance",
    }
    assert {c.id for c in model.customers} == {"aurora", "borealis"}
    assert {c.plan for c in model.customers} == {"enterprise", "growth"}
    assert {r.identifier for r in model.resources} == {
        "resource://portfolio",
        "resource://research",
        "resource://compliance",
    }
    manifest = tenancy.load_manifest()
    assert manifest.capabilities_for("portfolio") == ["portfolio-read", "portfolio-write", "research-read"]


def test_each_application_owns_one_resource_and_provider():
    model = tenancy.load_model()
    portfolio = model.application("portfolio")
    assert portfolio.resource.identifier == "resource://portfolio"
    assert portfolio.provider.identifier == "pf-mandate"
    assert model.application_for_resource("resource://research").id == "research"


def test_application_commands_create_every_service():
    model = tenancy.load_model()
    apps = tenancy.application_commands(model)
    assert {c["flags"]["name"] for c in apps} == {"lynx-portfolio", "lynx-research", "lynx-compliance"}
    assert all(c["command"] == "app" and c["subcommand"] == "create" for c in apps)


def test_provider_and_resource_commands_bind_to_application():
    model = tenancy.load_model()
    providers = tenancy.provider_commands(model)
    assert {c["flags"]["identifier"] for c in providers} == {"pf-mandate", "rs-mandate", "cp-mandate"}
    assert all(c["flags"]["kind"] == "caracal_mandate" for c in providers)

    provider_ids = {c["flags"]["identifier"]: f"cp_{c['flags']['identifier']}" for c in providers}
    application_ids = {a.id: f"app_{a.id}" for a in model.applications}
    resources = tenancy.resource_commands(model, provider_ids, application_ids)
    assert {c["flags"]["identifier"] for c in resources} == {
        "resource://portfolio",
        "resource://research",
        "resource://compliance",
    }
    portfolio = next(c for c in resources if c["flags"]["identifier"] == "resource://portfolio")
    assert portfolio["flags"]["credential-provider-id"] == "cp_pf-mandate"
    assert portfolio["flags"]["gateway-application-id"] == "app_portfolio"
    assert portfolio["flags"]["scopes"] == ["portfolio:read", "portfolio:write", "portfolio:admin"]


def test_policy_commands_cover_the_library():
    model = tenancy.load_model()
    policies = tenancy.policy_commands(model)
    names = [c["flags"]["name"] for c in policies]
    assert names[0] == "00-base", "base policy must be authored first"
    for required in ("portfolio-write", "delegated-advisor", "emergency-access"):
        assert required in names
    assert all("package caracal.authz" in c["flags"]["content"] for c in policies)


def test_role_scopes_are_bounded_by_the_application_resource():
    # Without an application, a cross-domain role's full grant set is visible.
    unbounded = tenancy.role_scopes("portfolio")
    assert "research:read" in unbounded

    # Spawned under the portfolio application, the same role can only ever hold portfolio scopes.
    bounded = tenancy.role_scopes("portfolio", application="portfolio")
    assert "portfolio:write" in bounded
    assert "research:read" not in bounded
    assert "compliance:admin" not in bounded

    # A cross-domain auditor under the portfolio application is read-only on portfolio alone.
    auditor = tenancy.role_scopes("auditor", application="portfolio")
    assert auditor == ["portfolio:read"]


def test_agent_labels_are_capability_hints_not_tenancy():
    labels = tenancy.agent_labels("portfolio")
    assert labels == ["portfolio-read", "portfolio-write", "research-read"]
    assert not any(label.startswith("tenant:") for label in labels)


def test_customer_metadata_carries_the_subject_correlation():
    metadata = tenancy.customer_metadata("aurora", "portfolio", "portfolio")
    assert metadata == {"customer_id": "aurora", "role": "portfolio", "application_id": "portfolio"}
