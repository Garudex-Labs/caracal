"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

fx-rates SSE streaming server entry point.
"""
from __future__ import annotations

import os

import uvicorn

from _mock.streaming.fx_rates.server import app


if __name__ == "__main__":
    host = os.getenv("LYNX_FX_HOST", "0.0.0.0")
    port = int(os.getenv("LYNX_FX_PORT", "8810"))
    uvicorn.run(app, host=host, port=port, log_level=os.getenv("LYNX_LOG", "info"))
