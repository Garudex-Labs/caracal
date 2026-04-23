"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application entry point with router mounts and startup validation.
"""
from __future__ import annotations

import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.config import load_config

load_dotenv(Path(__file__).parent.parent / ".env")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_config()
    if not os.environ.get("OPENAI_API_KEY"):
        raise RuntimeError("OPENAI_API_KEY is required but not set.")

    # caracal-integration: construct Caracal client and check out workspace scope at startup
    api_key = os.environ.get("CARACAL_API_KEY", "")
    api_url = os.environ.get("CARACAL_API_URL", "")
    workspace_id = os.environ.get("CARACAL_WORKSPACE_ID", "")
    if not api_key or not api_url or not workspace_id:
        raise RuntimeError(
            "CARACAL_API_KEY, CARACAL_API_URL, and CARACAL_WORKSPACE_ID are required."
        )
    from caracal_sdk import CaracalClient
    from app.agents.tools import init_enforcement
    client = CaracalClient(api_key=api_key, base_url=api_url)
    scope = client.context.checkout(workspace_id=workspace_id)
    app.state.caracal = scope
    init_enforcement(scope=scope, loop=asyncio.get_event_loop())

    yield


app = FastAPI(title="Lynx Capital", lifespan=lifespan)

_static = Path(__file__).parent / "web" / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

from app.api import router as api_router
app.include_router(api_router, prefix="/api")

from app.web.router import router as web_router
app.include_router(web_router)
