"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK-local exceptions for binding boundaries and coordinator failures.
"""

from __future__ import annotations


class MissingTokenError(RuntimeError):
    """An inbound request reached a Caracal binding boundary without a bearer
    token. Middleware answers this with 401; pass ``as_application=True`` only for
    trusted service-root ingress."""


class CoordinatorError(RuntimeError):
    """The coordinator rejected a request; carries the HTTP status so callers
    can branch on it, and the server-requested retry delay when a Retry-After
    header arrived."""

    # Error bodies are capped so an oversized or sensitive-payload response
    # never lands wholesale in logs and error trackers.
    BODY_CAP = 2048

    def __init__(
        self,
        method: str,
        path: str,
        status: int,
        body: str,
        retry_after_seconds: float | None = None,
    ) -> None:
        capped = (
            f"{body[: self.BODY_CAP]}\u2026 (truncated)"
            if len(body) > self.BODY_CAP
            else body
        )
        super().__init__(f"coordinator {method} {path} failed: {status} {capped}")
        self.method = method
        self.path = path
        self.status = status
        self.retry_after_seconds = retry_after_seconds
        self.body = body
