"""Storage migration helpers for canonical CARACAL_HOME layout."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import List, Tuple

from caracal.storage.layout import CaracalLayout, ensure_layout, get_caracal_layout


@dataclass
class StorageMigrationSummary:
    """Result summary for storage migration."""

    source_root: str
    target_root: str
    moved_items: int
    skipped_items: int
    dry_run: bool
    operations: list[tuple[str, str]]


_CANONICAL_DIRS = {"keystore", "workspaces", "ledger", "system"}


def migrate_storage(
    source_root: Path | str,
    target_root: Path | str | None = None,
    *,
    dry_run: bool = False,
    purge_source: bool = False,
) -> StorageMigrationSummary:
    """Migrate canonical storage domains into a new CARACAL_HOME root."""
    source = Path(source_root).expanduser().resolve(strict=False)
    if target_root is None:
        target_layout = get_caracal_layout()
    else:
        target_layout = get_caracal_layout(home=target_root)

    target = target_layout.root.resolve(strict=False)
    if not source.exists():
        raise FileNotFoundError(f"Storage source path does not exist: {source}")

    ensure_layout(target_layout)

    operations: List[Tuple[str, str]] = []
    moved = 0
    skipped = 0

    for entry in sorted(source.iterdir(), key=lambda p: p.name):
        if entry.name not in _CANONICAL_DIRS:
            skipped += 1
            continue

        destination = target_layout.root / entry.name

        if entry.resolve(strict=False) == destination.resolve(strict=False):
            skipped += 1
            continue

        if destination.exists():
            skipped += 1
            continue

        operations.append((str(entry), str(destination)))
        moved += 1

    if not dry_run:
        for src_raw, dst_raw in operations:
            src = Path(src_raw)
            dst = Path(dst_raw)
            dst.parent.mkdir(parents=True, exist_ok=True)
            if purge_source:
                shutil.move(str(src), str(dst))
            else:
                if src.is_dir():
                    shutil.copytree(src, dst)
                else:
                    shutil.copy2(src, dst)

    return StorageMigrationSummary(
        source_root=str(source),
        target_root=str(target),
        moved_items=moved,
        skipped_items=skipped,
        dry_run=dry_run,
        operations=operations,
    )
