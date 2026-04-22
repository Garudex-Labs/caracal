"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application entry point with router mounts and startup validation.
"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import load_config


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_config()
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required but not set.")
    yield


app = FastAPI(title="Lynx Capital", lifespan=lifespan)

_static = Path(__file__).parent / "web" / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

from app.api import router as api_router
app.include_router(api_router, prefix="/api")

from app.web.router import router as web_router
app.include_router(web_router)
