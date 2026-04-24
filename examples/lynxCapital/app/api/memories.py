"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session memory endpoints: inspect and clear cross-run conversation state.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.session_memory import session_memory

router = APIRouter()


@router.get("")
def get_memories() -> JSONResponse:
    return JSONResponse(session_memory.as_dict())


@router.delete("")
def clear_memories() -> JSONResponse:
    session_memory.clear()
    return JSONResponse({"cleared": True})
