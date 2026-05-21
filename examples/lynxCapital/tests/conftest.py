"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Test fixtures start local provider services on free ports for application tests.
"""
from __future__ import annotations

import asyncio
import os
import socket
import sys
import tempfile
import threading
import time
from pathlib import Path

import pytest
import uvicorn

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Vendored provider SDK fixtures live under _mock/sdk/<pkg>/<pkg>/. When the
# example is launched via `uv run`, [tool.uv.sources] installs them editable.
# Bare `pytest` invocations skip that step, so make the package roots
# importable directly.
_LYNX_ROOT = Path(__file__).resolve().parents[1]
for _pkg in (_LYNX_ROOT / "_mock" / "sdk").glob("*/"):
    sys.path.insert(0, str(_pkg))

os.environ.setdefault("OPENAI_API_KEY", "test-key")

_caracal_toml = Path(tempfile.mkdtemp(prefix="caracal-lynx-tests-")) / "caracal.toml"
_caracal_toml.write_text(
    'zone_id = "test-zone"\n'
    'application_id = "test-app"\n'
    'app_client_secret = "test-secret"\n'
    'sts_url = "http://127.0.0.1:0"\n'
    'coordinator_url = "http://127.0.0.1:0"\n'
    'gateway_url = "http://127.0.0.1:0"\n'
    '[[credentials]]\n'
    'env = "LYNX_MERCURY_BANK_TOKEN"\n'
    'resource = "lynx/mercury-bank"\n'
    'upstream_prefix = "http://127.0.0.1:8800"\n',
    encoding="utf-8",
)
os.environ["CARACAL_CONFIG"] = str(_caracal_toml)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _UvicornInThread:
    def __init__(self, app, port: int):
        cfg = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio")
        self.server = uvicorn.Server(cfg)
        self.thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> None:
        self.thread.start()
        for _ in range(200):
            if self.server.started:
                return
            time.sleep(0.01)
        raise RuntimeError("uvicorn did not start")

    def stop(self) -> None:
        self.server.should_exit = True
        self.thread.join(timeout=3.0)


@pytest.fixture(scope="session")
def rest_url() -> str:
    from _mock.rest.app import app

    port = _free_port()
    server = _UvicornInThread(app, port)
    server.start()
    url = f"http://127.0.0.1:{port}"

    rest_envs = [
        "LYNX_MERCURY_URL", "LYNX_WISE_URL", "LYNX_STRIPE_URL", "LYNX_QB_URL",
        "LYNX_NETSUITE_URL", "LYNX_SAP_URL", "LYNX_OCR_URL", "LYNX_CLOSE_URL",
        "LYNX_REGULATORY_URL", "LYNX_BILLING_URL", "LYNX_TAX_URL",
        "LYNX_COMPLIANCE_URL", "LYNX_FX_URL",
    ]
    for env in rest_envs:
        os.environ[env] = url

    keys = {
        "LYNX_MERCURY_KEY":     "local-mercury-bank-key",
        "LYNX_WISE_KEY":        "local-wise-payouts-key",
        "LYNX_STRIPE_KEY":      "local-stripe-treasury-key",
        "LYNX_QB_KEY":          "local-quickbooks-key",
        "LYNX_NETSUITE_KEY":    "local-netsuite-key",
        "LYNX_SAP_KEY":         "local-sap-erp-key",
        "LYNX_OCR_KEY":         "local-ocr-vision-key",
        "LYNX_CLOSE_KEY":       "local-close-engine-key",
        "LYNX_REGULATORY_KEY":  "local-regulatory-filings-key",
        "LYNX_BILLING_KEY":     "local-customer-billing-key",
        "LYNX_TAX_KEY":         "local-tax-rules-key",
        "LYNX_COMPLIANCE_KEY":  "local-compliance-nexus-key",
        "LYNX_FX_KEY":          "local-fx-rates-key",
    }
    for k, v in keys.items():
        os.environ.setdefault(k, v)

    yield url
    server.stop()


@pytest.fixture(scope="session")
def fx_stream_url() -> str:
    from _mock.streaming.fx_rates.server import app

    port = _free_port()
    server = _UvicornInThread(app, port)
    server.start()
    url = f"http://127.0.0.1:{port}/v1/stream"
    os.environ["LYNX_FX_STREAM_URL"] = url
    yield url
    server.stop()


class _AsyncServerThread:
    def __init__(self, coro_factory):
        self._coro_factory = coro_factory
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task | None = None
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._ready = threading.Event()

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        self._task = loop.create_task(self._coro_factory())
        self._ready.set()
        try:
            loop.run_forever()
        finally:
            loop.close()

    def start(self) -> None:
        self._thread.start()
        self._ready.wait(timeout=2.0)

    def stop(self) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._loop.stop)
        self._thread.join(timeout=3.0)


@pytest.fixture(scope="session")
def treasury_grpc(rest_url) -> str:
    from _mock.grpc.treasury_ops.server import serve

    port = _free_port()
    addr = f"127.0.0.1:{port}"
    runner = _AsyncServerThread(lambda: serve(addr))
    runner.start()
    time.sleep(0.2)
    os.environ["LYNX_TREASURY_GRPC"] = addr
    os.environ.setdefault("LYNX_TREASURY_KEY", "local-treasury-ops-key")
    yield addr
    runner.stop()


@pytest.fixture(scope="session")
def compliance_grpc(rest_url) -> str:
    from _mock.grpc.compliance_stream.server import serve

    port = _free_port()
    addr = f"127.0.0.1:{port}"
    runner = _AsyncServerThread(lambda: serve(addr))
    runner.start()
    time.sleep(0.2)
    os.environ["LYNX_COMPLIANCE_GRPC"] = addr
    os.environ.setdefault("LYNX_COMPLIANCE_KEY", "local-compliance-nexus-key")
    yield addr
    runner.stop()


@pytest.fixture(scope="session")
def vendor_mcp() -> tuple[str, int]:
    from _mock.mcp.vendor_portal.server import serve

    port = _free_port()
    runner = _AsyncServerThread(lambda: serve("127.0.0.1", port))
    runner.start()
    time.sleep(0.2)
    os.environ["LYNX_MCP_HOST"] = "127.0.0.1"
    os.environ["LYNX_MCP_PORT"] = str(port)
    os.environ.setdefault("LYNX_VENDOR_PORTAL_KEY", "local-vendor-portal-key")
    yield ("127.0.0.1", port)
    runner.stop()
