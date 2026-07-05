"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

SDK-local exceptions for binding boundaries and coordinator failures.
"""

from __future__ import annotations


class MissingTokenError(RuntimeError):
    """An inbound request reached a Caracal binding boundary without a bearer
    token. Middleware answers this with 401; pass ``allow_root=True`` only for
    trusted service-root ingress."""


class CoordinatorError(RuntimeError):
    """The coordinator rejected a request; carries the HTTP status so callers
    can branch on it."""

    def __init__(self, method: str, path: str, status: int, body: str) -> None:
        super().__init__(f"coordinator {method} {path} failed: {status} {body}")
        self.method = method
        self.path = path
        self.status = status
        self.body = body
