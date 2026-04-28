"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Lightweight mock HTTP server that serves provider API responses for the demo.
"""
from __future__ import annotations

import json
import logging
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

_DATA_DIR = Path(__file__).parent
_SERVICE_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_cases: dict[str, dict] = {}
_LOG = logging.getLogger(__name__)


def _load(service_id: str) -> dict:
    if not _SERVICE_ID_RE.fullmatch(service_id):
        raise KeyError(service_id)
    if service_id not in _cases:
        path = (_DATA_DIR / f"{service_id}.mock" / "cases.json").resolve()
        try:
            path.relative_to(_DATA_DIR.resolve())
        except ValueError as exc:
            raise KeyError(service_id) from exc
        if not path.exists():
            raise KeyError(service_id)
        _cases[service_id] = json.loads(path.read_text(encoding="utf-8"))
    return _cases[service_id]


def _resolve_key(match_key: str | list, payload: dict[str, Any]) -> str:
    if isinstance(match_key, list):
        return "|".join(str(payload.get(k, "")) for k in match_key)
    return str(payload.get(match_key, ""))


def _dispatch(service_id: str, action: str, payload: dict[str, Any]) -> tuple[int, dict]:
    try:
        spec = _load(service_id)
    except KeyError:
        return 404, {"error": f"unknown service: {service_id!r}"}
    action_spec = spec["actions"].get(action)
    if action_spec is None:
        return 404, {"error": f"unknown action: {action!r} for service: {service_id!r}"}
    key = _resolve_key(action_spec["match_key"], payload)
    cases = action_spec["cases"]
    return 200, dict(cases.get(key, cases["default"]))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: Any) -> None:
        _LOG.debug(
            '%s - - [%s] %s',
            self.address_string(),
            self.log_date_time_string(),
            fmt % args,
        )

    def do_GET(self) -> None:
        self._reply(200, {"status": "ok"})

    def do_POST(self) -> None:
        host = self.headers.get("Host", "")
        host_name = host
        if ":" in host:
            maybe_host, maybe_port = host.rsplit(":", 1)
            if maybe_port.isdigit():
                host_name = maybe_host
        if not host_name.endswith(".mock"):
            self._reply(400, {"error": "invalid host header: expected <service>.mock[:port]"})
            return
        service_id = host_name[: -len(".mock")]
        if not service_id:
            self._reply(400, {"error": "invalid host header: missing service id"})
            return
        action = urlparse(self.path).path.strip("/")
        length = int(self.headers.get("Content-Length", 0))
        payload: dict = {}
        if length:
            raw_body = self.rfile.read(length)
            try:
                payload = json.loads(raw_body)
            except json.JSONDecodeError:
                self._reply(400, {"error": "invalid JSON in request body"})
                return
        status, data = _dispatch(service_id, action, payload)
        self._reply(status, data)

    def _reply(self, status: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    host = os.getenv("MOCK_SERVER_HOST", "127.0.0.1")
    port = int(os.getenv("MOCK_SERVER_PORT", "80"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"Mock provider server listening on {host}:{port}", flush=True)
    server.serve_forever()
