"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

compliance-nexus gRPC streaming mock server entry point.
"""
from __future__ import annotations

import asyncio
import os

from _mock.grpc.compliance_stream.server import serve


if __name__ == "__main__":
    asyncio.run(serve(os.getenv("LYNX_GRPC_COMPLIANCE_ADDR", "0.0.0.0:50052")))
