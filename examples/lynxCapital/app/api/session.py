"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session endpoints: two-state gate (landing accepted, setup validated).
"""
from __future__ import annotations

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

router = APIRouter()

COOKIE = "lynx_accepted"
SETUP_COOKIE = "lynx_setup"


@router.post("/accept")
def accept(response: Response) -> dict:
    response.set_cookie(COOKIE, "1", max_age=86400, httponly=False, samesite="lax")
    return {"accepted": True}


@router.post("/setup-complete")
def setup_complete(request: Request, response: Response):
    if request.cookies.get(COOKIE) != "1":
        denied = JSONResponse(
            status_code=403,
            content={"detail": "Accept terms before completing setup."},
        )
        denied.delete_cookie(SETUP_COOKIE)
        return denied
    response.set_cookie(SETUP_COOKIE, "1", max_age=86400, httponly=False, samesite="lax")
    return {"setup": True}
