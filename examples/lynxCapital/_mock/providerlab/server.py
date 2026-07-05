"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Single-provider entry point that serves one lab provider on its catalog port.
"""

from __future__ import annotations

import os

import uvicorn

from _mock.providerlab import catalog
from _mock.providerlab.app import build_app


def main() -> None:
    provider_id = os.environ["PROVIDERLAB_PROVIDER"]
    provider = catalog.get(provider_id)
    host = os.getenv("PROVIDERLAB_HOST", "127.0.0.1")
    port = int(os.getenv("PROVIDERLAB_PORT", str(provider.port)))
    uvicorn.run(build_app(provider), host=host, port=port, log_level="warning")


if __name__ == "__main__":
    main()
