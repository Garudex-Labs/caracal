"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

MCP-shaped client: minimal JSON-RPC 2.0 over a length-prefixed TCP socket.
Handles tools/list and tools/call with retry/breaker.
"""
from __future__ import annotations

import json
import os
import socket
import struct
import threading
from typing import Any

from app.services.resilience import RetryPolicy, breaker, with_retry


class McpError(RuntimeError):
    def __init__(self, code: int, message: str, data: Any = None):
        super().__init__(f"mcp {code}: {message}")
        self.status = code
        self.code = code
        self.body = {"error": message, "data": data}
        self.retry_after_s = None


_RETRYABLE = {429, 500, 502, 503, 504}


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    return isinstance(exc, McpError) and exc.code in _RETRYABLE


class McpClient:
    def __init__(self, provider: str, host: str, port: int, auth_env: str,
                 *, policy: RetryPolicy = RetryPolicy(), timeout_s: float = 4.0):
        self.provider = provider
        self._host = host
        self._port = port
        self._auth_env = auth_env
        self._timeout = timeout_s
        self._policy = policy
        self._breaker = breaker(provider)
        self._lock = threading.Lock()
        self._sock: socket.socket | None = None
        self._req_id = 0

    def close(self) -> None:
        with self._lock:
            if self._sock is not None:
                try:
                    self._sock.close()
                finally:
                    self._sock = None

    def _connect(self) -> socket.socket:
        if self._sock is not None:
            return self._sock
        s = socket.create_connection((self._host, self._port), timeout=self._timeout)
        self._sock = s
        self._send(s, {"jsonrpc": "2.0", "id": self._next_id(), "method": "initialize", "params": {}})
        self._recv(s)
        return s

    def _next_id(self) -> int:
        self._req_id += 1
        return self._req_id

    def _send(self, s: socket.socket, msg: dict) -> None:
        body = json.dumps(msg).encode()
        s.sendall(struct.pack(">I", len(body)) + body)

    def _recv(self, s: socket.socket) -> dict:
        header = self._recv_exact(s, 4)
        (length,) = struct.unpack(">I", header)
        return json.loads(self._recv_exact(s, length).decode())

    @staticmethod
    def _recv_exact(s: socket.socket, n: int) -> bytes:
        buf = bytearray()
        while len(buf) < n:
            chunk = s.recv(n - len(buf))
            if not chunk:
                raise ConnectionError("mcp connection closed")
            buf.extend(chunk)
        return bytes(buf)

    def _request(self, method: str, params: dict) -> Any:
        def _attempt(_: int) -> Any:
            with self._lock:
                try:
                    s = self._connect()
                    req_id = self._next_id()
                    self._send(s, {"jsonrpc": "2.0", "id": req_id, "method": method, "params": params})
                    resp = self._recv(s)
                except (ConnectionError, OSError, socket.timeout):
                    self.close()
                    raise
            if "error" in resp:
                err = resp["error"]
                self._breaker.on_failure()
                raise McpError(int(err.get("code", 500)), err.get("message", "error"), err.get("data"))
            return resp.get("result")

        return with_retry(self.provider, _attempt,
                          policy=self._policy, is_retryable=_is_retryable,
                          breaker_obj=self._breaker)

    def list_tools(self) -> list[dict]:
        return list((self._request("tools/list", {}) or {}).get("tools", []))

    def call_tool(self, name: str, arguments: dict) -> dict:
        token = os.getenv(self._auth_env, "")
        result = self._request("tools/call", {
            "name": name, "arguments": arguments,
            "auth": {"token": token},
        })
        for item in result.get("content", []):
            if item.get("type") == "json":
                return item.get("data", {})
        return result
