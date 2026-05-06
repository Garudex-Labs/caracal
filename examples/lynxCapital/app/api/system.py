"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

System health, config, and runtime model switcher endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_config
from app.core.memory import MODEL_CONTEXT_LIMITS
from app.core.settings import ALLOWED_MODELS, settings

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
        "scenario": cfg.scenario.model_dump(),
        "theme": cfg.theme.model_dump(),
    }


class ModelResponse(BaseModel):
    model: str
    allowed: list[str]
    contextLimit: int


class ModelChangeRequest(BaseModel):
    model: str


@router.get("/model")
def get_model() -> ModelResponse:
    return ModelResponse(
        model=settings.model,
        allowed=list(ALLOWED_MODELS),
        contextLimit=MODEL_CONTEXT_LIMITS.get(settings.model, 128_000),
    )


@router.post("/model")
def set_model(body: ModelChangeRequest) -> ModelResponse:
    try:
        settings.set_model(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return ModelResponse(
        model=settings.model,
        allowed=list(ALLOWED_MODELS),
        contextLimit=MODEL_CONTEXT_LIMITS.get(settings.model, 128_000),
    )

