"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

REST mock server entry point.
"""
from __future__ import annotations

import os

import uvicorn

from _mock.rest.app import app


if __name__ == "__main__":
    host = os.getenv("LYNX_REST_HOST", "0.0.0.0")
    port = int(os.getenv("LYNX_REST_PORT", "8800"))
    uvicorn.run(app, host=host, port=port, log_level=os.getenv("LYNX_LOG", "info"))
