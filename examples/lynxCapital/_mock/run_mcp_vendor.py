"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

vendor-portal MCP-shape mock server entry point.
"""
from __future__ import annotations

import asyncio
import os

from _mock.mcp.vendor_portal.server import serve


if __name__ == "__main__":
    asyncio.run(serve(
        os.getenv("LYNX_MCP_HOST", "0.0.0.0"),
        int(os.getenv("LYNX_MCP_PORT", "7800")),
    ))
