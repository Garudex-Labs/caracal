"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

ASGI middleware that verifies and binds CaracalContext at the request boundary.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from collections.abc import Awaitable, Callable

from .context import VerifiedClaims
from .errors import MissingTokenError

if TYPE_CHECKING:
    from .client import Caracal


Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]
TokenVerifier = Callable[[str], Awaitable[VerifiedClaims | None]]


class CaracalASGIMiddleware:
    """ASGI middleware that binds Caracal context from inbound headers on HTTP
    and WebSocket connections.

    When a ``verifier`` is supplied it runs at the boundary before binding, so
    the request reaches the application only after the mandate has been proven;
    claims the verifier returns override the caller-supplied envelope. Boundary
    failures answer the client directly - 401 for HTTP, policy-violation close
    (1008) for WebSocket - while errors raised by the application itself
    propagate unchanged. The middleware never inspects token internals; that
    belongs to the injected callable (typically backed by
    ``caracalai_identity.verify_token``).
    """

    def __init__(
        self,
        app: ASGIApp,
        caracal: Caracal,
        *,
        allow_root: bool = False,
        verifier: TokenVerifier | None = None,
    ) -> None:
        self.app = app
        self.caracal = caracal
        self.allow_root = allow_root
        self.verifier = verifier

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") not in ("http", "websocket"):
            await self.app(scope, receive, send)
            return
        raw = scope.get("headers", [])
        headers: dict[str, str] = {}
        for k, v in raw:
            headers[k.decode("latin-1")] = v.decode("latin-1")
        binder = self.caracal.bind_from_headers(
            headers, allow_root=self.allow_root, verifier=self.verifier
        )
        try:
            await binder.__aenter__()
        except MissingTokenError:
            await _reject(scope, send, "missing_token", "Missing bearer token")
            return
        except Exception:
            await _reject(scope, send, "invalid_token", "Token verification failed")
            return
        try:
            await self.app(scope, receive, send)
        except BaseException as exc:
            if not await binder.__aexit__(type(exc), exc, exc.__traceback__):
                raise
        else:
            await binder.__aexit__(None, None, None)


async def _reject(scope: Scope, send: Send, code: str, message: str) -> None:
    if scope.get("type") == "websocket":
        await send({"type": "websocket.close", "code": 1008})
        return
    await send(
        {
            "type": "http.response.start",
            "status": 401,
            "headers": [(b"content-type", b"application/json")],
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": f'{{"error":"{code}","message":"{message}"}}'.encode("latin-1"),
        }
    )
