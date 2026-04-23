"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session endpoints: disclaimer acceptance gate for the demo flow.
"""
from __future__ import annotations

from fastapi import APIRouter, Response

router = APIRouter()

COOKIE = "lynx_accepted"


@router.post("/accept")
def accept(response: Response) -> dict:
    response.set_cookie(COOKIE, "1", max_age=86400, httponly=False, samesite="lax")
    return {"accepted": True}


@router.post("/clear")
def clear(response: Response) -> dict:
    response.delete_cookie(COOKIE)
    return {"accepted": False}
