"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Opt-in human-in-the-loop approval gate that pauses irreversible operations until a reviewer decides.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from uuid import uuid4

from app.core.settings import settings


def _timeout() -> float:
    try:
        return float(os.environ.get("LYNX_APPROVAL_TIMEOUT", "300"))
    except ValueError:
        return 300.0


@dataclass
class _Pending:
    action: str = ""
    event: asyncio.Event = field(default_factory=asyncio.Event)
    approved: bool = False
    note: str = ""


@dataclass
class Decision:
    approved: bool
    reason: str


class ApprovalGate:
    """Per-process registry of pending approvals. When approval gating is off
    the gate auto-approves so autonomous runs are unaffected; when on it
    blocks the requesting tool until a reviewer resolves it or the wait times
    out (timeout denies, which is the safe default for financial actions)."""

    def __init__(self) -> None:
        self._pending: dict[str, dict[str, _Pending]] = {}
        self._lock = asyncio.Lock()

    def required(self) -> bool:
        return settings.approvals_required()

    async def request(self, run_id: str, action: str) -> tuple[str, _Pending]:
        request_id = f"appr-{uuid4().hex[:10]}"
        pending = _Pending(action=action)
        async with self._lock:
            self._pending.setdefault(run_id, {})[request_id] = pending
        return request_id, pending

    async def wait(self, run_id: str, request_id: str, pending: _Pending) -> Decision:
        try:
            await asyncio.wait_for(pending.event.wait(), timeout=_timeout())
        except asyncio.TimeoutError:
            await self._discard(run_id, request_id)
            return Decision(False, "approval timed out")
        await self._discard(run_id, request_id)
        return Decision(
            pending.approved,
            pending.note or ("approved" if pending.approved else "denied"),
        )

    def resolve(
        self, run_id: str, request_id: str, approved: bool, note: str = ""
    ) -> bool:
        pending = self._pending.get(run_id, {}).get(request_id)
        if pending is None:
            return False
        pending.approved = approved
        pending.note = note
        pending.event.set()
        return True

    def list_pending(self, run_id: str) -> list[dict[str, str]]:
        return [
            {"requestId": rid, "action": p.action}
            for rid, p in self._pending.get(run_id, {}).items()
        ]

    async def _discard(self, run_id: str, request_id: str) -> None:
        async with self._lock:
            requests = self._pending.get(run_id)
            if requests:
                requests.pop(request_id, None)
                if not requests:
                    self._pending.pop(run_id, None)


approvals = ApprovalGate()
