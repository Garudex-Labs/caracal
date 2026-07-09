"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Structured control-plane operation events reported to observability hooks.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class CaracalEvent:
    """One completed control-plane operation: a token exchange (``type``
    ``token.exchange``, cache hits carry ``cached``), an approval wait
    (``approval.wait``), a coordinator call (``coordinator.call``), or a
    delegation acceptance (``delegation.accept``, carrying the delegation and
    session ids for forensic correlation). Every event carries the outcome and
    duration; ``status`` holds the HTTP status when a response arrived and
    ``code`` the platform error code when the operation failed with one.
    Bridge events to any metrics or tracing system; a hook that raises is
    ignored and never disturbs the operation that emitted the event."""

    type: str
    ok: bool
    duration_ms: float = 0.0
    resources: tuple[str, ...] = ()
    scopes: tuple[str, ...] = ()
    cached: bool = False
    status: int = 0
    code: str = ""
    method: str = ""
    path: str = ""
    approval_id: str = ""
    state: str = ""
    delegation_id: str = ""
    session_id: str = ""


EventHook = Callable[[CaracalEvent], None]


def emit_event(hook: EventHook | None, event: CaracalEvent) -> None:
    """Deliver an event to a hook; the observability sink must never break
    the operation path, so hook failures are swallowed."""
    if hook is None:
        return
    try:
        hook(event)
    except Exception:
        pass
