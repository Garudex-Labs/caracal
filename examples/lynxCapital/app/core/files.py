"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Per-run in-memory file store for DeepAgents-style externalized memory
(write_file / read_file / ls) so agents can offload large tool results and
keep prompt context small.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from threading import Lock
from time import time


@dataclass
class StoredFile:
    path: str
    content: str
    size: int
    written_at: float
    written_by: str


@dataclass
class RunFileStore:
    run_id: str
    _files: dict[str, StoredFile] = field(default_factory=dict)
    _lock: Lock = field(default_factory=Lock)

    def write(self, agent_id: str, path: str, content: str) -> StoredFile:
        clean = _normalize(path)
        with self._lock:
            f = StoredFile(
                path=clean, content=content, size=len(content),
                written_at=time(), written_by=agent_id,
            )
            self._files[clean] = f
            return f

    def read(self, path: str) -> StoredFile | None:
        with self._lock:
            return self._files.get(_normalize(path))

    def ls(self) -> list[dict]:
        with self._lock:
            return [
                {"path": f.path, "size": f.size, "written_by": f.written_by[:8]}
                for f in self._files.values()
            ]


def _normalize(path: str) -> str:
    p = (path or "").strip().lstrip("/").replace("\\", "/")
    if not p:
        p = "untitled"
    return p[:240]
