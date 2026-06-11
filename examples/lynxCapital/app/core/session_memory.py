"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Session-level conversation and run history retained across multiple runs.
"""
from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Literal

MAX_TURNS = 20   # user + assistant pairs kept
MAX_RUNS = 10    # run records kept
log = logging.getLogger("lynx.session_memory")


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
    """Session store with optional JSON file persistence so conversation and
    run history survive process restarts. Set LYNX_SESSION_PATH to enable."""

    def __init__(self, path: str | None = None) -> None:
        self._turns: list[Turn] = []
        self._runs: list[RunRecord] = []
        self._lock = Lock()
        self._path = Path(path) if path else None
        self._load()

    def add_user(self, content: str, run_id: str) -> None:
        with self._lock:
            self._turns.append(Turn(role="user", content=content, run_id=run_id))
            self._trim()
        self._persist()

    def add_assistant(self, content: str, run_id: str) -> None:
        with self._lock:
            self._turns.append(Turn(role="assistant", content=content, run_id=run_id))
            self._trim()
        self._persist()

    def record_run(self, record: RunRecord) -> None:
        with self._lock:
            self._runs.append(record)
            if len(self._runs) > MAX_RUNS:
                self._runs = self._runs[-MAX_RUNS:]
        self._persist()

    def context_block(self, query: str = "") -> str:
        """Return a compact context string for LLM injection, or '' if no history.

        When `query` is given, the most keyword-relevant prior runs are surfaced
        alongside the most recent ones so long-lived sessions can recall older
        work without a vector store."""
        with self._lock:
            runs = list(self._runs)
            turns = list(self._turns)
        lines: list[str] = []

        if runs:
            recent = runs[-5:]
            selected = list(recent)
            relevant = self._rank_runs(query, runs, exclude=recent, limit=3) if query else []
            for r in relevant:
                if r not in selected:
                    selected.insert(0, r)
            lines.append("PREVIOUS RUNS (most relevant first, then most recent):")
            for r in selected:
                lines.append(f"  - {r.summary()}")

        if turns:
            lines.append("RECENT CONVERSATION:")
            for t in turns[-8:]:
                role = "User" if t.role == "user" else "Assistant"
                snippet = t.content[:150].replace("\n", " ")
                lines.append(f"  {role}: {snippet}")

        return "\n".join(lines)

    @staticmethod
    def _tokens(text: str) -> set[str]:
        return {w for w in "".join(c.lower() if c.isalnum() else " " for c in text).split() if len(w) > 2}

    def _rank_runs(self, query: str, runs: list[RunRecord], exclude: list[RunRecord],
                   limit: int) -> list[RunRecord]:
        terms = self._tokens(query)
        if not terms:
            return []
        scored: list[tuple[int, float, RunRecord]] = []
        for i, r in enumerate(runs):
            if r in exclude:
                continue
            overlap = len(terms & self._tokens(f"{r.prompt} {' '.join(r.regions)}"))
            if overlap:
                scored.append((overlap, r.ts, r))
        scored.sort(key=lambda s: (s[0], s[1]), reverse=True)
        return [r for _, _, r in scored[:limit]]

    def last_run(self) -> RunRecord | None:
        with self._lock:
            return self._runs[-1] if self._runs else None

    def clear(self) -> None:
        with self._lock:
            self._turns.clear()
            self._runs.clear()
        self._persist()

    def _trim(self) -> None:
        if len(self._turns) > MAX_TURNS * 2:
            self._turns = self._turns[-(MAX_TURNS * 2):]

    def _load(self) -> None:
        if not self._path or not self._path.exists():
            return
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        with self._lock:
            self._runs = [
                RunRecord(
                    run_id=r["run_id"], prompt=r["prompt"], status=r["status"],
                    regions=list(r.get("regions") or []),
                    errors=list(r.get("errors") or []),
                    ts=float(r.get("ts") or time.time()),
                )
                for r in data.get("runs", [])
            ]
            self._turns = [
                Turn(role=t["role"], content=t["content"],
                     run_id=t.get("run_id"), ts=float(t.get("ts") or time.time()))
                for t in data.get("turns", [])
            ]

    def _persist(self) -> None:
        if not self._path:
            return
        with self._lock:
            payload = {
                "runs": [
                    {
                        "run_id": r.run_id, "prompt": r.prompt, "status": r.status,
                        "regions": r.regions, "errors": r.errors, "ts": r.ts,
                    }
                    for r in self._runs
                ],
                "turns": [
                    {"role": t.role, "content": t.content, "run_id": t.run_id, "ts": t.ts}
                    for t in self._turns
                ],
            }
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(self._path.suffix + ".tmp")
            tmp.write_text(json.dumps(payload), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError as exc:
            log.warning("failed to persist session memory to %s: %s", self._path, exc)


session_memory = SessionMemory(os.environ.get("LYNX_SESSION_PATH") or None)
