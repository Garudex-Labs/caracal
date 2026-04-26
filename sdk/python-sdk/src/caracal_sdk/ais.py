"""AIS routing helpers for SDK clients."""

from __future__ import annotations

import os


def ais_socket_configured() -> bool:
    """Return True when an AIS Unix socket path is configured."""
    return bool((os.environ.get("CCL_AIS_UNIX_SOCKET_PATH") or "").strip())


def resolve_ais_base_url() -> str | None:
    """Resolve AIS base URL when socket-based AIS mode is enabled."""
    if not ais_socket_configured():
        return None

    host = (os.environ.get("CCL_AIS_LISTEN_HOST") or "127.0.0.1").strip() or "127.0.0.1"
    port = (os.environ.get("CCL_AIS_LISTEN_PORT") or "7079").strip() or "7079"
    prefix = (os.environ.get("CCL_AIS_API_PREFIX") or "/v1/ais").strip() or "/v1/ais"
    normalized_prefix = prefix if prefix.startswith("/") else f"/{prefix}"
    normalized_prefix = normalized_prefix.rstrip("/")

    return f"http://{host}:{port}{normalized_prefix}"


def resolve_sdk_base_url(default_port: str = "8080") -> str:
    """Resolve canonical SDK base URL for runtime API operations.

    SDK runtime operations target API routes like ``/mcp/*`` and should not
    implicitly route to the AIS host/port based on socket configuration.
    """
    return os.environ.get("CCL_API_URL", f"http://localhost:{default_port}")
