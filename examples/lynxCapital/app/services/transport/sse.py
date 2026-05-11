"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SSE consumer: long-lived background thread reading text/event-stream lines and
publishing each event onto the in-process bus, with reconnect+resume support.
"""
from __future__ import annotations

import json
import os
import threading
import time
from typing import Callable

import httpx


class SseConsumer:
    def __init__(
        self,
        provider: str,
        url: str,
        auth_header: str,
        auth_env: str,
        on_event: Callable[[str, dict], None],
        *,
        params: dict[str, str] | None = None,
        timeout_s: float = 30.0,
        backoff_s: float = 1.0,
    ):
        self.provider = provider
        self._url = url
        self._auth_header = auth_header
        self._auth_env = auth_env
        self._on_event = on_event
        self._params = params or {}
        self._timeout = timeout_s
        self._backoff = backoff_s
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_id: str | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name=f"sse-{self.provider}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _headers(self) -> dict[str, str]:
        token = os.getenv(self._auth_env, "")
        h = {"Accept": "text/event-stream"}
        if token:
            h[self._auth_header] = token
        if self._last_id is not None:
            h["Last-Event-ID"] = self._last_id
        return h

    def _run(self) -> None:
        backoff = self._backoff
        while not self._stop.is_set():
            try:
                with httpx.stream("GET", self._url, headers=self._headers(),
                                  params=self._params, timeout=self._timeout) as r:
                    if r.status_code >= 400:
                        raise RuntimeError(f"sse {r.status_code}")
                    backoff = self._backoff
                    self._read_events(r)
            except Exception:
                if self._stop.is_set():
                    return
                time.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    def _read_events(self, r: httpx.Response) -> None:
        event = "message"
        data_lines: list[str] = []
        for line in r.iter_lines():
            if self._stop.is_set():
                return
            if line is None:
                continue
            if line == "":
                if data_lines:
                    payload = "\n".join(data_lines)
                    try:
                        data = json.loads(payload)
                    except json.JSONDecodeError:
                        data = {"raw": payload}
                    self._on_event(event, data)
                event, data_lines = "message", []
                continue
            if line.startswith(":"):
                continue
            field, _, value = line.partition(":")
            value = value.lstrip()
            if field == "id":
                self._last_id = value
            elif field == "event":
                event = value or "message"
            elif field == "data":
                data_lines.append(value)
