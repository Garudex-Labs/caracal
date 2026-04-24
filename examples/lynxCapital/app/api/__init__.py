"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

API package - mounts system, run, logs, observe, session, and setup routers.
"""
from fastapi import APIRouter

from app.api.system import router as system_router
from app.api.run import router as run_router
from app.api.logs import router as logs_router
from app.api.memories import router as memories_router
from app.api.observe import router as observe_router
from app.api.session import router as session_router
from app.api.setup import router as setup_router

router = APIRouter()
router.include_router(system_router, prefix="/system")
router.include_router(run_router, prefix="/run")
router.include_router(logs_router, prefix="/logs")
router.include_router(memories_router, prefix="/memories")
router.include_router(observe_router, prefix="/observe")
router.include_router(session_router, prefix="/session")
router.include_router(setup_router, prefix="/setup")
