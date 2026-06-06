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

import httpx

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
    protocol_names = ", ".join(item["name"].upper() for item in overview["protocols"])
    category_names = ", ".join(sorted({p.category.replace("_", " ") for p in cfg.providers}))
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
                "A request starts as business intent, moves through Finance Control "
                "and workflow agents, then reaches local provider fixtures through "
                "the same application boundary used by the demo runtime."
            ),
            "body": [
                (
                    "The provider network runs under _mock on localhost ports "
                    f"9400-9419 and represents {overview['provider_count']} provider surfaces."
                ),
                (
                    f"Provider protocols represented here: {protocol_names}. "
                    f"Operational categories include {category_names}."
                ),
            ],
            "items": [
                {
                    "label": "Application",
                    "value": (
                        "FastAPI on port 8000 with server-rendered pages and "
                        "plain JavaScript enhancement."
                    ),
                },
                {
                    "label": "Workflow runtime",
                    "value": (
                        "LangGraph and LangChain-based orchestration with visible "
                        "chat, graph, logs, prompts, and activity history."
                    ),
                },
                {
                    "label": "Provider boundary",
                    "value": "Local REST, SSE, gRPC-style, MCP, and SDK fixtures under _mock.",
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
                    "Setup validates OPENAI_API_KEY, the local provider network, "
                    "provider webhook secrets, and Caracal services when enabled."
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


def _health_status(url: str) -> str:
    try:
        with httpx.Client(timeout=0.35) as client:
            response = client.get(f"{url.rstrip('/')}/healthz")
        return "Online" if response.status_code < 500 else "Offline"
    except httpx.HTTPError:
        return "Offline"


def _setup_requirements() -> list[dict[str, object]]:
    services = [
        ("API", os.environ.get("CARACAL_API_URL", "http://localhost:3000")),
        ("STS", os.environ.get("CARACAL_STS_URL", "http://localhost:8080")),
        ("Gateway", os.environ.get("CARACAL_GATEWAY_URL", "http://localhost:8081")),
        ("Audit", os.environ.get("CARACAL_AUDIT_URL", "http://localhost:9090")),
        ("Coordinator", os.environ.get("CARACAL_COORDINATOR_URL", "http://localhost:4000")),
    ]
    return [
        {"name": name, "endpoint": url, "status": _health_status(url)}
        for name, url in services
    ]


def _setup_commands() -> list[dict[str, str]]:
    return [
        {
            "step": "01",
            "action": "Bind the application identity",
            "description": "Set the Caracal zone and application identifiers used by the SDK client.",
            "command": "CARACAL_ZONE_ID=zone_lynxcapital\nCARACAL_APPLICATION_ID=app_lynxcapital",
            "expected": "Lynx can construct a Caracal runtime identity for delegated work.",
        },
        {
            "step": "02",
            "action": "Configure application auth",
            "description": "Provide the application secret for STS token exchange, or a subject token for local bring-up.",
            "command": "CARACAL_APP_CLIENT_SECRET=<application-secret>\n# or\nCARACAL_SUBJECT_TOKEN=<local-subject-token>",
            "expected": "The SDK can obtain or use application authority without exposing provider secrets.",
        },
        {
            "step": "03",
            "action": "Point at Caracal services",
            "description": "Connect the SDK to the STS, coordinator, and gateway services already running for the demo.",
            "command": "CARACAL_STS_URL=http://localhost:8080\nCARACAL_COORDINATOR_URL=http://localhost:4000\nCARACAL_GATEWAY_URL=http://localhost:8081",
            "expected": "Validation can reach each Caracal control-plane endpoint.",
        },
        {
            "step": "04",
            "action": "Map provider resources",
            "description": "Register provider upstreams with the Caracal gateway so Lynx routes through resource ids.",
            "command": "CARACAL_RESOURCES=meridian-pay=http://127.0.0.1:9401,halcyon-bank=http://127.0.0.1:9400",
            "expected": "Gateway calls carry X-Caracal-Resource and resolve to the configured upstreams.",
        },
    ]


def _setup_ctx(request: Request) -> dict:
    ctx = _ctx(request)
    providers = setup_catalog.provider_entries(get_config().providers)
    requirements = _setup_requirements()
    ready_requirements = sum(1 for item in requirements if item["status"] == "Online")
    ctx.update({
        "setup_providers": providers,
        "setup_requirements": requirements,
        "setup_commands": _setup_commands(),
        "setup_progress": {
            "ready": ready_requirements,
            "total": len(requirements),
            "percent": round((ready_requirements / len(requirements)) * 100),
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
