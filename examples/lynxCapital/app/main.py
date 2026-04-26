"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

FastAPI application entry point with Caracal client initialization.
"""
from __future__ import annotations

import asyncio
import json
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
    api_key = os.environ.get("CCL_API_KEY", "")
    api_url = os.environ.get("CCL_API_URL", "")
    workspace_id = os.environ.get("CCL_WORKSPACE_ID", "")
    if api_key and api_url and workspace_id:
        import httpx
        from caracal_sdk import CaracalClient
        from app.agents.tools import init_enforcement
        jwt_token = api_key
        try:
            async with httpx.AsyncClient() as http:
                resp = await http.post(
                    f"{api_url.rstrip('/')}/mcp/token",
                    headers={"Authorization": f"Bearer {api_key}"},
                    timeout=10,
                )
        except httpx.RequestError:
            pass
        else:
            if resp.status_code == 200:
                try:
                    data = resp.json()
                except json.JSONDecodeError:
                    pass
                else:
                    if isinstance(data, dict):
                        jwt_token = data.get("access_token", api_key)
        client = CaracalClient(api_key=jwt_token, base_url=api_url)
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
