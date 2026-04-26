"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Helpers for resolving caracal source files across namespace package roots.
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterator


def caracal_source_roots() -> list[Path]:
    """Return the on-disk source roots that contribute to the caracal namespace."""
    import caracal
    return [Path(p) for p in caracal.__path__ if Path(p).exists()]


def caracal_path(*subparts: str) -> Path:
    """Resolve a path under the caracal/ source tree across all contributing roots."""
    for root in caracal_source_roots():
        candidate = root.joinpath(*subparts)
        if candidate.exists():
            return candidate
    raise FileNotFoundError(
        f"caracal source path not found: {'/'.join(subparts)} (searched {caracal_source_roots()})"
    )


def caracal_iter_files(suffix: str = ".py") -> Iterator[Path]:
    """Iterate every source file under caracal/ matching the given suffix."""
    for root in caracal_source_roots():
        yield from root.rglob(f"*{suffix}")
