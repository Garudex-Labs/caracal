"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application entry point with Caracal client initialization.
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

    # caracal-integration: construct Caracal client and check out workspace scope at startup
    session_token = os.environ.get("CCL_SESS_TOKEN", "")
    api_url = os.environ.get("CCL_API_URL", "")
    workspace_id = os.environ.get("CCL_WORKSPACE_ID", "")
    if session_token and api_url and workspace_id:
        from caracal_sdk import CaracalClient
        from app.agents.tools import init_enforcement
        client = CaracalClient(api_key=session_token, base_url=api_url)
        scope = client.context.checkout(workspace_id=workspace_id)
        app.state.caracal = scope
        init_enforcement(scope=scope, loop=asyncio.get_running_loop())

    yield


app = FastAPI(title="Lynx Capital", lifespan=lifespan)

_static = Path(__file__).parent / "web" / "static"
if _static.exists():
    app.mount("/static", StaticFiles(directory=str(_static)), name="static")

from app.api import router as api_router
app.include_router(api_router, prefix="/api")

from app.web.router import router as web_router
app.include_router(web_router)
