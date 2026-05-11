"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

treasury-ops gRPC mock server entry point.
"""
from __future__ import annotations

import asyncio
import os

from _mock.grpc.treasury_ops.server import serve


if __name__ == "__main__":
    asyncio.run(serve(os.getenv("LYNX_GRPC_TREASURY_ADDR", "0.0.0.0:50051")))
