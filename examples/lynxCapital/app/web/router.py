"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Web HTML routes: landing, overview, setup, demo, and logs pages.
"""
from __future__ import annotations

import os
import shutil
import sys
from collections import Counter
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse, Response
from fastapi.templating import Jinja2Templates
from pathlib import Path

from app.api.hooks import required_secret_envs
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


def _setup_requirements(providers: list[dict[str, object]]) -> list[dict[str, object]]:
    missing_provider_vars = sorted({
        variable
        for provider in providers
        for variable in provider["missing"]
    })
    missing_webhook_secrets = [name for name in required_secret_envs() if not os.environ.get(name)]
    return [
        {
            "name": "Python runtime",
            "scope": "Required",
            "status": "Configured" if sys.version_info >= (3, 14) else "Missing",
            "detail": f"Python 3.14+ application runtime; current interpreter is {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}.",
        },
        {
            "name": "Docker",
            "scope": "Required",
            "status": "Configured" if shutil.which("docker") else "Missing",
            "detail": "Runs the local provider network used by Lynx Capital.",
        },
        {
            "name": "OpenAI API Key",
            "scope": "Required",
            "status": "Configured" if os.environ.get("OPENAI_API_KEY") else "Missing",
            "detail": "OPENAI_API_KEY powers the orchestration layer.",
        },
        {
            "name": "Provider secrets",
            "scope": "Required",
            "status": "Configured" if not missing_provider_vars else "Missing",
            "detail": "All provider credential variables are present." if not missing_provider_vars else f"{len(missing_provider_vars)} provider credential variables are missing.",
        },
        {
            "name": "Webhook secrets",
            "scope": "Required",
            "status": "Configured" if not missing_webhook_secrets else "Missing",
            "detail": "All callback signing secrets are present." if not missing_webhook_secrets else f"Missing {', '.join(missing_webhook_secrets)}.",
        },
        {
            "name": "Caracal runtime",
            "scope": "Optional",
            "status": "Configured" if os.environ.get("CARACAL_ZONE_ID") and os.environ.get("CARACAL_APPLICATION_ID") else "Optional",
            "detail": "Set CARACAL_ZONE_ID and CARACAL_APPLICATION_ID to route through Caracal; otherwise Lynx uses direct local providers.",
        },
    ]


def _setup_commands() -> list[dict[str, str]]:
    return [
        {
            "step": "01",
            "action": "Prepare environment",
            "description": "Create a local environment file and set OPENAI_API_KEY before launching the app.",
            "command": "cp .env.example .env\n# edit .env and set OPENAI_API_KEY=sk-...",
            "expected": ".env contains the required OpenAI and Lynx configuration.",
        },
        {
            "step": "02",
            "action": "Generate provider credentials",
            "description": "Print ready-to-source provider credentials from deterministic local provider stores.",
            "command": "python -m _mock.providerlab.seedenv",
            "expected": "Credential exports are available for provider API keys, tokens, and OAuth clients.",
        },
        {
            "step": "03",
            "action": "Start provider network",
            "description": "Launches local provider services used by the demo.",
            "command": "docker compose -f _mock/docker-compose.yml up -d --build --wait",
            "expected": "Provider services report healthy on localhost ports 9400-9419.",
        },
        {
            "step": "04",
            "action": "Launch Lynx Capital",
            "description": "Runs the FastAPI application with server-rendered UI and SSE event stream.",
            "command": "uv run uvicorn app.main:app --reload --port 8000",
            "expected": "Lynx Capital is available at http://127.0.0.1:8000.",
        },
    ]


def _setup_ctx(request: Request) -> dict:
    ctx = _ctx(request)
    providers = setup_catalog.provider_entries(get_config().providers)
    ready_requirements = sum(1 for item in _setup_requirements(providers) if item["status"] in ("Configured", "Optional"))
    ctx.update({
        "setup_providers": providers,
        "setup_requirements": _setup_requirements(providers),
        "setup_commands": _setup_commands(),
        "setup_progress": {
            "ready": ready_requirements,
            "total": 6,
            "percent": round((ready_requirements / 6) * 100),
        },
        "setup_links": {
            "overview": "/overview/about",
            "credentials": "http://127.0.0.1:9400/__lab/credentials",
            "providerDashboard": "http://127.0.0.1:9400/",
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
