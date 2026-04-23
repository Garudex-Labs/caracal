"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Web HTML routes: landing, setup, demo, logs, and observe pages.
"""
from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from pathlib import Path

from app.api.session import COOKIE
from app.config import get_config

router = APIRouter()
templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))


def _accepted(request: Request) -> bool:
    return request.cookies.get(COOKIE) == "1"


def _ctx(request: Request) -> dict:
    cfg = get_config()
    return {
        "request": request,
        "company": cfg.company,
        "shortName": cfg.shortName,
        "theme": cfg.theme.model_dump(),
        "content": cfg.content.model_dump(),
        "scenario": cfg.scenario.model_dump(),
        "regions": [r.model_dump() for r in cfg.regions],
        "agentLayers": [l.model_dump() for l in cfg.agentLayers],
        "providers": [p.model_dump() for p in cfg.providers],
        "accepted": _accepted(request),
    }


@router.get("/", response_class=HTMLResponse)
def landing(request: Request):
    return templates.TemplateResponse("landing.html", _ctx(request))


@router.get("/setup", response_class=HTMLResponse)
def setup(request: Request):
    return templates.TemplateResponse("setup.html", _ctx(request))


@router.get("/demo", response_class=HTMLResponse)
def demo(request: Request):
    if not _accepted(request):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("demo.html", _ctx(request))


@router.get("/logs", response_class=HTMLResponse)
def logs(request: Request):
    if not _accepted(request):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("logs.html", _ctx(request))


@router.get("/observe", response_class=HTMLResponse)
def observe(request: Request):
    if not _accepted(request):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("observe.html", _ctx(request))
