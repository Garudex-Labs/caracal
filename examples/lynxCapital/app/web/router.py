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
                    "Setup is Caracal-side only: create a zone, application, and "
                    "policy, then map each provider to a resource."
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
]


def _env(name: str) -> str:
    return os.environ.get(name, "").strip()


def _caracal_steps() -> list[dict[str, str]]:
    zone = _env("CARACAL_ZONE_ID") or "zone_lynxcapital"
    application = _env("CARACAL_APPLICATION_ID") or "app_lynxcapital"
    return [
        {
            "step": "01",
            "title": "Create the zone",
            "console": "In Caracal Console, create a zone for this workspace. The zone is the tenancy boundary every application, provider, and policy lives in.",
            "why": "Lynx runs as one application inside a single Caracal zone.",
            "field": "CARACAL_ZONE_ID",
            "value": zone,
        },
        {
            "step": "02",
            "title": "Register the application",
            "console": "Add a Caracal application inside the zone and issue its client secret. This is the identity the Lynx SDK presents for delegated work.",
            "why": "The application authenticates Lynx to STS and the gateway without exposing provider secrets.",
            "field": "CARACAL_APPLICATION_ID",
            "value": application,
        },
        {
            "step": "03",
            "title": "Publish the access policy",
            "console": "Create a policy in the zone that allows the Lynx application to read and act on the resources it routes to. Activate the policy set.",
            "why": "The gateway evaluates this policy on every provider call Lynx makes.",
            "field": "CARACAL_APP_CLIENT_SECRET",
            "value": "<application-secret-from-console>",
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
    ctx.update({
        "setup_providers": providers,
        "setup_external_count": len(external),
        "setup_mapped_count": len(mapped),
        "setup_caracal_steps": _caracal_steps(),
        "setup_automate": _automate_plan(),
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
