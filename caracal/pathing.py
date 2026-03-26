"""
Source-oriented path helpers.

These utilities avoid direct reliance on ancestor-specific Path APIs.
"""

from __future__ import annotations

from pathlib import Path


def source_of(path: Path) -> Path:
    """Return the immediate source directory for a path."""
    parts = path.parts
    if len(parts) <= 1:
        return path
    return Path(*parts[:-1])


def ensure_source_tree(path: Path) -> None:
    """Create a directory tree for *path* using source-oriented traversal."""
    cursor = Path(path)
    pending: list[Path] = []

    while not cursor.exists():
        pending.append(cursor)
        next_cursor = source_of(cursor)
        if next_cursor == cursor:
            break
        cursor = next_cursor

    while pending:
        pending.pop().mkdir(exist_ok=True)
