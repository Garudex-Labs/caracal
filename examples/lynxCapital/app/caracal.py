"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Lynx Capital's Caracal singleton: loads caracal.toml via the SDK and exposes a small accessor surface to the swarm.
"""
from __future__ import annotations

from contextlib import AsyncExitStack
from typing import Any

from caracalai_sdk import Caracal, CaracalContext
from caracalai_sdk.coordinator import AgentKind


_caracal: Caracal | None = None


def init() -> Caracal:
    global _caracal
    if _caracal is None:
        _caracal = Caracal.from_config()
    return _caracal


def get() -> Caracal | None:
    return _caracal


def headers() -> dict[str, str]:
    return _caracal.headers() if _caracal is not None else {}


async def enter(
    stack: AsyncExitStack,
    role: str,
    *,
    session_sid: str,
    region: str | None = None,
    scope: str | None = None,
    kind: AgentKind = AgentKind.INSTANCE,
    ttl_seconds: int | None = None,
    extra: dict[str, Any] | None = None,
) -> CaracalContext | None:
    if _caracal is None:
        return None
    meta: dict[str, Any] = {"role": role, "run_id": session_sid}
    if region:
        meta["region"] = region
    if scope:
        meta["scope"] = scope
    if extra:
        meta.update(extra)
    return await stack.enter_async_context(
        _caracal.spawn(
            kind=kind,
            ttl_seconds=ttl_seconds,
            metadata=meta,
        )
    )
