"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

System health and config endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from app.config import get_config

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    company: str


@router.get("/health")
def health() -> HealthResponse:
    cfg = get_config()
    return HealthResponse(status="ok", company=cfg.company)


@router.get("/config")
def config() -> dict:
    cfg = get_config()
    return {
        "company": cfg.company,
        "shortName": cfg.shortName,
        "regions": [{"id": r.id, "name": r.name, "currency": r.currency} for r in cfg.regions],
        "providers": [{"id": p.id, "name": p.name, "category": p.category} for p in cfg.providers],
        "agentLayers": [
            {"id": l.id, "label": l.label, "perRegion": l.perRegion, "ephemeral": l.ephemeral}
            for l in cfg.agentLayers
        ],
        "swarm": {"llmBackedCap": cfg.swarm.llmBackedCap},
        "scenario": cfg.scenario.model_dump(),
        "theme": cfg.theme.model_dump(),
    }
