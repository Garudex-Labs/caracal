"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session-level conversation and run history retained across multiple runs.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal

MAX_TURNS = 20   # user + assistant pairs kept
MAX_RUNS = 10    # run records kept


@dataclass
class RunRecord:
    run_id: str
    prompt: str
    status: str            # completed | failed | denied | cancelled
    regions: list[str]
    errors: list[str]
    ts: float = field(default_factory=time.time)

    def summary(self) -> str:
        parts = [f"[{self.run_id[:8]}] prompt={self.prompt[:80]!r} → {self.status}"]
        if self.regions:
            parts.append(f"regions: {', '.join(self.regions)}")
        if self.errors:
            parts.append(f"errors: {'; '.join(self.errors[:2])}")
        return " | ".join(parts)


@dataclass
class Turn:
    role: Literal["user", "assistant"]
    content: str
    run_id: str | None = None
    ts: float = field(default_factory=time.time)


class SessionMemory:
    """In-process session store. Cleared on server restart or via DELETE /api/memories."""

    def __init__(self) -> None:
        self._turns: list[Turn] = []
        self._runs: list[RunRecord] = []

    def add_user(self, content: str, run_id: str) -> None:
        self._turns.append(Turn(role="user", content=content, run_id=run_id))
        self._trim()

    def add_assistant(self, content: str, run_id: str) -> None:
        self._turns.append(Turn(role="assistant", content=content, run_id=run_id))
        self._trim()

    def record_run(self, record: RunRecord) -> None:
        self._runs.append(record)
        if len(self._runs) > MAX_RUNS:
            self._runs = self._runs[-MAX_RUNS:]

    def context_block(self) -> str:
        """Return a compact context string for LLM injection, or '' if no history."""
        lines: list[str] = []

        if self._runs:
            lines.append("PREVIOUS RUNS (most recent last):")
            for r in self._runs[-5:]:
                lines.append(f"  - {r.summary()}")

        if self._turns:
            lines.append("RECENT CONVERSATION:")
            for t in self._turns[-8:]:
                role = "User" if t.role == "user" else "Assistant"
                snippet = t.content[:150].replace("\n", " ")
                lines.append(f"  {role}: {snippet}")

        return "\n".join(lines)

    def last_run(self) -> RunRecord | None:
        return self._runs[-1] if self._runs else None

    def clear(self) -> None:
        self._turns.clear()
        self._runs.clear()

    def as_dict(self) -> dict:
        return {
            "runs": [
                {
                    "run_id": r.run_id,
                    "prompt": r.prompt,
                    "status": r.status,
                    "regions": r.regions,
                    "errors": r.errors,
                    "ts": r.ts,
                }
                for r in self._runs
            ],
            "turns": [
                {"role": t.role, "content": t.content[:200], "ts": t.ts}
                for t in self._turns
            ],
        }

    def _trim(self) -> None:
        if len(self._turns) > MAX_TURNS * 2:
            self._turns = self._turns[-(MAX_TURNS * 2):]


session_memory = SessionMemory()
