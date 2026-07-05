"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application entry point.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import load_config

# Workload configuration: hand-authored .env first, then the provisioner-managed file of
# application ids and client secrets (config/provisioned.env), which overrides so freshly
# provisioned credentials always take effect without a manual merge.
_ROOT = Path(__file__).parent.parent
load_dotenv(_ROOT / ".env")
load_dotenv(_ROOT / "config" / "provisioned.env", override=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_config()
    from app import caracal

    # Build the per-application Caracal runtimes at startup so token exchange and
    # resource views are ready before the first run; no-op when unconfigured.
    caracal.startup()
    from app.services.streams import start_streams, stop_streams

    start_streams()
    try:
        yield
    finally:
        stop_streams()
        await caracal.aclose()


app = FastAPI(title="Lynx Capital", lifespan=lifespan)

_static = Path(__file__).parent / "web" / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

from app.api import router as api_router

app.include_router(api_router, prefix="/api")

from app.api.hooks import router as hooks_router

app.include_router(hooks_router)

from app.web.router import router as web_router

app.include_router(web_router)
