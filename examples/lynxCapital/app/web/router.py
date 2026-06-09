"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Web HTML routes: landing, overview, setup, demo, and logs pages.
"""
from __future__ import annotations

import os
from collections import Counter
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from pathlib import Path

from app.api.session import COOKIE, SETUP_COOKIE
from app.config import get_config
from app.services import setup_catalog
from app import tenancy

router = APIRouter()
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def _accepted(request: Request) -> bool:
    return request.cookies.get(COOKIE) == "1"


def _setup_validated(request: Request) -> bool:
    return request.cookies.get(SETUP_COOKIE) == "1"


def _overview() -> dict:
    cfg = get_config()
    auth = Counter(p.authType for p in cfg.providers)
    protocols = Counter(p.protocol for p in cfg.providers)
    categories = Counter(p.category for p in cfg.providers)
    persistent_agents = 1 + sum(
        l.perRegion * len(cfg.regions) for l in cfg.agentLayers if not l.ephemeral
    )
    ephemeral_agents = sum(
        l.perRegion * len(cfg.regions) for l in cfg.agentLayers if l.ephemeral
    )
    return {
        "provider_count": len(cfg.providers),
        "workflow_count": len(cfg.workflows),
        "region_count": len(cfg.regions),
        "agent_layer_count": len(cfg.agentLayers),
        "persistent_agents": persistent_agents,
        "ephemeral_agents": ephemeral_agents,
        "auth_methods": [{"name": k, "count": v} for k, v in sorted(auth.items())],
        "protocols": [{"name": k, "count": v} for k, v in sorted(protocols.items())],
        "categories": [{"name": k, "count": v} for k, v in sorted(categories.items())],
        "internal_providers": [p.model_dump() for p in cfg.providers if p.authType == "none"],
        "mandate_providers": [p.model_dump() for p in cfg.providers if p.authType == "caracal_mandate"],
    }


def _workflow_label(workflow: dict) -> str:
    if workflow["id"] == "vendorLifecycle":
        return "Vendor Operations"
    return workflow["label"]


def _overview_pages() -> dict[str, dict]:
    cfg = get_config()
    overview = _overview()
    workflows = [w.model_dump() for w in cfg.workflows]
    operations = [
        {"label": _workflow_label(workflow), "focus": workflow["focus"]}
        for workflow in workflows
    ]
    return {
        "about": {
            "title": f"About {cfg.company}",
            "route": "/overview/about",
            "next": "/overview/architecture",
            "previous": None,
            "intro": (
                f"{cfg.company} is a runnable reference lab for autonomous financial execution. "
                "It models a global SaaS payout cycle with a FastAPI application, "
                "LangGraph-based swarm, live topology view, and SSE activity stream."
            ),
            "body": [
                f"The configured scenario is {cfg.scenario.description.strip()}",
                (
                    "Use this overview before setup to understand the workspace, "
                    "the provider boundary, and the demo-only operating model."
                ),
            ],
            "items": [
                {"label": "Workspace purpose", "value": cfg.content.tagline},
                {"label": "Primary scenario", "value": cfg.content.scenarioTitle},
                {"label": "Covered operations", "value": ", ".join(item["label"] for item in operations)},
            ],
        },
        "architecture": {
            "title": "Architecture & Providers",
            "route": "/overview/architecture",
            "next": "/overview/notice",
            "previous": "/overview/about",
            "intro": (
                "Your instruction starts as business intent, moves through Finance "
                "Control and workflow agents, and reaches each provider through "
                "Caracal — which brokers identity, policy, and access on every call."
            ),
            "body": [
                (
                    f"The workspace coordinates {overview['provider_count']} finance "
                    "provider surfaces across treasury, payments, compliance, "
                    "procurement, and accounting."
                ),
                (
                    "You never hold a provider secret. Caracal maps each provider to "
                    "a resource, issues short-lived authority, and routes the request "
                    "through its gateway."
                ),
            ],
            "items": [
                {
                    "label": "How a request flows",
                    "value": (
                        "Intent becomes a delegated agent run, then a policy-checked "
                        "provider call through the Caracal gateway."
                    ),
                },
                {
                    "label": "What Caracal handles",
                    "value": (
                        "Application identity, scoped authority, access policy, and "
                        "an audited path to every provider."
                    ),
                },
                {
                    "label": "What you configure",
                    "value": "A zone, an application, a policy, and one resource per provider.",
                },
            ],
        },
        "notice": {
            "title": "Demo Environment Notice",
            "route": "/overview/notice",
            "next": None,
            "previous": "/overview/architecture",
            "intro": cfg.content.disclaimer.strip(),
            "body": [
                (
                    "No real money moves, no production compliance decision is made, "
                    "and generated outcomes require human review."
                ),
                (
                    "Setup is Caracal-side only: fill the zone, application, and "
                    "policy fields, then map each provider to a resource."
                ),
            ],
            "items": [
                {
                    "label": "Real",
                    "value": (
                        "Application routing, orchestration, provider calls, setup "
                        "validation, events, logs, approvals, memory, and UI state."
                    ),
                },
                {
                    "label": "Simulated",
                    "value": (
                        "Provider accounts, generated credentials, invoices, payments, "
                        "tax responses, screening results, market data, and audit records."
                    ),
                },
                {
                    "label": "Required acknowledgement",
                    "value": "Confirm this is a demonstration environment before setup is unlocked.",
                },
            ],
        },
    }


def _ctx(request: Request) -> dict:
    cfg = get_config()
    accepted = _accepted(request)
    return {
        "company": cfg.company,
        "shortName": cfg.shortName,
        "theme": cfg.theme.model_dump(),
        "content": cfg.content.model_dump(),
        "scenario": cfg.scenario.model_dump(),
        "regions": [r.model_dump() for r in cfg.regions],
        "agentLayers": [l.model_dump() for l in cfg.agentLayers],
        "providers": [p.model_dump() for p in cfg.providers],
        "workflows": [w.model_dump() for w in cfg.workflows],
        "overview": _overview(),
        "accepted": accepted,
        "setup_validated": accepted and _setup_validated(request),
    }


def _overview_ctx(request: Request, key: str) -> dict:
    pages = _overview_pages()
    page = pages[key]
    order = ["about", "architecture", "notice"]
    ctx = _ctx(request)
    ctx.update(
        {
            "overview_page": page,
            "overview_pages": [pages[item] for item in order],
            "overview_index": order.index(key) + 1,
            "overview_total": len(order),
            "requires_ack": key == "notice",
        }
    )
    return ctx


CONTROL_SCOPES = [
    "control:identity-provider:read",
    "control:identity-provider:write",
    "control:resource:read",
    "control:resource:write",
    "control:policy:read",
    "control:policy:write",
    "control:policy-set:read",
    "control:policy-set:write",
]


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _resource_upstream(resource: "tenancy.ResourceSpec", index: int) -> str:
    """The upstream URL a domain resource is served at for this environment: the value of its
    upstreamEnv when set, otherwise the canonical local demo port (9500, 9501, 9502)."""
    return resource.upstream_url() or f"http://127.0.0.1:{9500 + index}"


def _resource_bindings() -> list[dict[str, str]]:
    """The domain resources paired with their upstream URLs, in model order — the source for
    both the CARACAL_RESOURCES workload line and the LYNX_RESOURCE_*_URL provisioning lines."""
    model = tenancy.load_model()
    bindings: list[dict[str, str]] = []
    for index, app in enumerate(model.applications):
        resource = app.resource
        bindings.append({
            "slug": resource.resourceId,
            "upstream": _resource_upstream(resource, index),
            "env": resource.upstreamEnv,
        })
    return bindings


def _caracal_steps() -> list[dict[str, object]]:
    cfg = get_config()
    model = tenancy.load_model()
    zone = _env("CARACAL_ZONE_ID") or "<zone-id>"
    application = _env("CARACAL_APPLICATION_ID") or "<managed-application-id>"
    app_names = ", ".join(f"\"{a.applicationName}\"" for a in model.applications)
    return [
        {
            "step": "01",
            "title": "Create the zone",
            "path": "Go to Caracal Console > Zones > New",
            "consoleFields": [
                {"label": "Name", "value": f"\"{cfg.company}\""},
                {"label": "Zone ID", "value": zone},
            ],
            "why": "The zone is the isolation boundary that owns the managed applications, the domain resources, and the policy set. One zone backs the whole Lynx Capital platform.",
            "field": "CARACAL_ZONE_ID",
            "value": zone,
        },
        {
            "step": "02",
            "title": "Create one managed application per service",
            "path": f"Go to Applications > New in the \"{cfg.company}\" zone",
            "consoleFields": [
                {"label": "Names", "value": app_names},
                {"label": "Registration method", "value": "managed"},
                {"label": "Resource each may reach", "value": ", ".join(f"{a.applicationName} → {a.resource.identifier}" for a in model.applications)},
            ],
            "why": "Each domain service runs as its own durable managed application — its own trust boundary that can reach only its own resource. A customer's agents are spawned as least-privilege sessions under the relevant service application. Download each caracal.toml profile (or copy the Application ID and one-time secret into CARACAL_APPLICATION_ID and CARACAL_APP_CLIENT_SECRET for that service); the secret is shown once.",
            "field": "CARACAL_APPLICATION_ID",
            "value": application,
        },
        {
            "step": "03",
            "title": "Register the credential providers and domain resources",
            "path": "Control key > identity-provider create, then resource create",
            "consoleFields": [
                {"label": "Providers", "value": ", ".join(a.provider.identifier for a in model.applications)},
                {"label": "Resources", "value": ", ".join(a.resource.identifier for a in model.applications)},
                {"label": "Upstreams", "value": ", ".join(f"{b['slug']}={b['upstream']}" for b in _resource_bindings())},
            ],
            "why": "Each domain service is a Caracal resource the Gateway protects, bound to a credential provider that forwards the agent's mandate upstream and to the one application allowed to select it. scripts/provision.py creates these idempotently from config/tenancy.yaml and the LYNX_RESOURCE_*_URL values in .env.provision.",
        },
        {
            "step": "04",
            "title": "Import the policy library and activate the policy set",
            "path": "Go to Policies > Import, then Policy sets > Activate",
            "consoleFields": [
                {"label": "Library", "value": "examples/lynxCapital/policies"},
                {"label": "Policy set", "value": f"\"{model.policySet.name}\""},
                {"label": "Activate", "value": "latest version"},
            ],
            "why": "The library's 00-base policy plus eleven scenario policies enforce per-customer subject scoping, role capabilities, plan entitlements, delegation, and step-up. The active policy set is evaluated on every token exchange and gateway call.",
        },
        {
            "step": "05",
            "title": "Serve customers as subjects",
            "path": "Application code — caracal.spawn_customer_agent(customer_id, role, application_id=...)",
            "consoleFields": [
                {"label": "Customers", "value": ", ".join(f"{c.id} ({c.plan})" for c in model.customers)},
                {"label": "Identity", "value": "subject + spawn metadata"},
                {"label": "Applications", "value": ", ".join(a.applicationName for a in model.applications)},
            ],
            "why": "Each customer is a Caracal subject, not a separate application. Each service application spawns least-privilege agents narrowed to its own resource scopes, correlating the customer in the subject and spawn metadata. The policy set differentiates customers by their subject claims, so isolation never depends on a forgeable label or scope name.",
        },
    ]


def _automate_plan() -> dict[str, object]:
    return {
        "scopes": CONTROL_SCOPES,
    }


def _setup_ctx(request: Request) -> dict:
    ctx = _ctx(request)
    providers = setup_catalog.provider_entries(get_config().providers)
    resources = setup_catalog.resource_bindings()
    external = [p for p in providers if p["external"]]
    mapped = [p for p in external if p["id"] in resources]
    configured = {
        "zone": bool(_env("CARACAL_ZONE_ID")),
        "application": bool(_env("CARACAL_APPLICATION_ID")),
        "auth": bool(_env("CARACAL_APP_CLIENT_SECRET") or _env("CARACAL_SUBJECT_TOKEN")),
        "providers": bool(external) and len(mapped) == len(external),
    }
    ready = sum(1 for value in configured.values() if value)
    model = tenancy.load_model()
    bindings = _resource_bindings()
    resources_line = ",".join(f"{b['slug']}={b['upstream']}" for b in bindings)
    applications = [
        {
            "id": app.id,
            "name": app.applicationName,
            "applicationId": (
                _env("CARACAL_APPLICATION_ID")
                if app.id == "portfolio" and _env("CARACAL_APPLICATION_ID")
                else f"<{app.applicationName}-application-id>"
            ),
            "secret": f"<{app.applicationName}-secret>",
            "resource": f"{app.resource.resourceId}={_resource_upstream(app.resource, idx)}",
        }
        for idx, app in enumerate(model.applications)
    ]
    ctx.update({
        "setup_providers": providers,
        "setup_external_count": len(external),
        "setup_mapped_count": len(mapped),
        "setup_caracal_steps": _caracal_steps(),
        "setup_automate": _automate_plan(),
        "setup_env": {
            "zone": _env("CARACAL_ZONE_ID") or "<zone-id>",
            "application": _env("CARACAL_APPLICATION_ID") or "<managed-application-id>",
            "applicationSecret": "<managed-application-secret>",
            "applications": applications,
            "resources": _env("CARACAL_RESOURCES") or resources_line,
            "resourceLines": [{"env": b["env"], "url": b["upstream"]} for b in bindings],
            "openaiKey": "sk-...",
            "controlClient": "<control-key-client-id>",
            "controlSecret": "<one-time-control-key-secret>",
        },
        "setup_progress": {
            "ready": ready,
            "total": len(configured),
            "percent": round((ready / len(configured)) * 100),
        },
        "setup_links": {
            "overview": "/overview/about",
        },
    })
    return ctx


@router.get("/", response_class=HTMLResponse)
def landing(request: Request):
    return templates.TemplateResponse(request, "landing.html", _ctx(request))


@router.get("/overview/about", response_class=HTMLResponse)
def overview_about(request: Request):
    return templates.TemplateResponse(request, "overview.html", _overview_ctx(request, "about"))


@router.get("/overview/architecture", response_class=HTMLResponse)
def overview_architecture(request: Request):
    return templates.TemplateResponse(request, "overview.html", _overview_ctx(request, "architecture"))


@router.get("/overview/notice", response_class=HTMLResponse)
def overview_notice(request: Request):
    return templates.TemplateResponse(request, "overview.html", _overview_ctx(request, "notice"))


@router.get("/favicon.ico")
def favicon() -> Response:
    return Response(status_code=204)


@router.get("/setup", response_class=HTMLResponse)
def setup(request: Request):
    if not _accepted(request):
        return RedirectResponse(url="/overview/about", status_code=303)
    return templates.TemplateResponse(request, "setup.html", _setup_ctx(request))


def _require_ready(request: Request):
    if not _accepted(request):
        return RedirectResponse(url="/overview/about", status_code=303)
    if not _setup_validated(request):
        return RedirectResponse(url="/setup", status_code=303)
    return None


@router.get("/demo", response_class=HTMLResponse)
def demo(request: Request):
    redirect = _require_ready(request)
    if redirect is not None:
        return redirect
    return templates.TemplateResponse(request, "demo.html", _ctx(request))


@router.get("/logs", response_class=HTMLResponse)
def logs(request: Request):
    redirect = _require_ready(request)
    if redirect is not None:
        return redirect
    return templates.TemplateResponse(request, "logs.html", _ctx(request))


@router.get("/prompts", response_class=HTMLResponse)
def prompts(request: Request):
    redirect = _require_ready(request)
    if redirect is not None:
        return redirect
    return templates.TemplateResponse(request, "prompts.html", _ctx(request))
