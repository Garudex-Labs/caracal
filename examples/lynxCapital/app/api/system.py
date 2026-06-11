"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

System health and model switcher endpoints.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.config import get_config
from app.core.memory import MODEL_CONTEXT_LIMITS
from app.core.settings import ALLOWED_MODELS, settings
from app.events.bus import bus
from app.events.types import model_change

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    company: str


@router.get("/health")
def health() -> HealthResponse:
    cfg = get_config()
    return HealthResponse(status="ok", company=cfg.company)


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
        model, prior = settings.set_model(body.model)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if model != prior:
        for run_id in bus.runs():
            history = bus.history(run_id)
            if history and not any(e.kind == "run_end" for e in history):
                bus.publish(model_change(run_id, model, prior))
    return ModelResponse(
        model=settings.model,
        allowed=list(ALLOWED_MODELS),
        contextLimit=MODEL_CONTEXT_LIMITS.get(settings.model, 128_000),
    )
