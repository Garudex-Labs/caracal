"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Local launcher that serves every lab provider on its own localhost port in one process.
"""

from __future__ import annotations

import os
import threading
import time

import uvicorn

from _mock.providerlab import catalog, stsbridge
from _mock.providerlab.app import build_app

HOST = os.environ.get("PROVIDERLAB_HOST", "127.0.0.1")


def _serve(provider: catalog.Provider) -> None:
    config = uvicorn.Config(
        build_app(provider), host=HOST, port=provider.port, log_level="warning"
    )
    uvicorn.Server(config).run()


def main() -> None:
    sts_url = os.environ.get("CARACAL_STS_URL", "").strip()
    issuer = os.environ.get("CARACAL_STS_ISSUER", "http://localhost:8080").strip()
    if sts_url and stsbridge.start(issuer, sts_url):
        print(f"provider lab: STS bridge {issuer} -> {sts_url}")
    for provider in catalog.CATALOG:
        threading.Thread(
            target=_serve, args=(provider,), daemon=True, name=f"lab-{provider.id}"
        ).start()
    print(
        f"provider lab: {len(catalog.CATALOG)} providers on {HOST}:{catalog.CATALOG[0].port}-{catalog.CATALOG[-1].port}"
    )
    for provider in catalog.CATALOG:
        print(
            f"  {provider.port}  {provider.category:<28} {provider.brand}  http://{HOST}:{provider.port}/"
        )
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
