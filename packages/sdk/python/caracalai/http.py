"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

ASGI middleware that verifies and binds CaracalContext at the request boundary.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from collections.abc import Awaitable, Callable

from .envelope import decode_envelope

if TYPE_CHECKING:
    from .client import Caracal


Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]
TokenVerifier = Callable[[str], Awaitable[None]]


class CaracalASGIMiddleware:
    """ASGI middleware that binds Caracal context from inbound headers.

    When a ``verifier`` is supplied it runs at the boundary before binding, so
    the request reaches the application only after the mandate has been proven.
    The middleware never inspects token internals itself; verification belongs to
    the injected callable (typically backed by ``caracalai_identity.verify_token``).
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
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        raw = scope.get("headers", [])
        headers: dict[str, str] = {}
        for k, v in raw:
            headers[k.decode("latin-1")] = v.decode("latin-1")
        try:
            if self.verifier is not None:
                token = decode_envelope(headers.get).subject_token
                if not token:
                    if not self.allow_root:
                        await _reject(send, "missing_token", "Missing bearer token")
                        return
                else:
                    await self.verifier(token)
            async with self.caracal.bind_from_headers(
                headers, allow_root=self.allow_root
            ):
                await self.app(scope, receive, send)
            return
        except RuntimeError as err:
            if "missing a bearer token" not in str(err):
                raise
            await _reject(send, "missing_token", "Missing bearer token")
            return


async def _reject(send: Send, code: str, message: str) -> None:
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
