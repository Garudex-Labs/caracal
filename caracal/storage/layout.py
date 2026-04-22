"""Canonical storage layout for Caracal runtime data."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)

_CARACAL_HOME_ENV = "CARACAL_HOME"
_CARACAL_CONFIG_DIR_ENV = "CARACAL_CONFIG_DIR"


class StorageLayoutError(RuntimeError):
    """Raised when storage layout is invalid or cannot be created safely."""


@dataclass(frozen=True)
class CaracalLayout:
    """Resolved storage layout rooted under CARACAL_HOME."""

    root: Path

    @property
    def keystore_dir(self) -> Path:
        return self.root / "keystore"

    @property
    def workspaces_dir(self) -> Path:
        return self.root / "workspaces"

    @property
    def ledger_dir(self) -> Path:
        return self.root / "ledger"

    @property
    def merkle_dir(self) -> Path:
        return self.ledger_dir / "merkle"

    @property
    def audit_logs_dir(self) -> Path:
        return self.ledger_dir / "audit_logs"

    @property
    def system_dir(self) -> Path:
        return self.root / "system"

    @property
    def metadata_dir(self) -> Path:
        return self.system_dir / "metadata"

    @property
    def history_dir(self) -> Path:
        return self.system_dir / "history"


def resolve_caracal_home(require_explicit: bool = False) -> Path:
    """Resolve CARACAL_HOME root.

    Resolution order is deterministic:
    1. CARACAL_CONFIG_DIR (demo/override alias)
    2. CARACAL_HOME
    3. ~/.caracal (only when require_explicit=False)
    """
    config_dir_value = os.getenv(_CARACAL_CONFIG_DIR_ENV)
    if config_dir_value:
        return Path(config_dir_value).expanduser().resolve(strict=False)

    home_value = os.getenv(_CARACAL_HOME_ENV)
    if home_value:
        return Path(home_value).expanduser().resolve(strict=False)

    if require_explicit:
        raise StorageLayoutError(
            "CARACAL_HOME is required but not set. Set CARACAL_HOME to an explicit runtime path."
        )

    return (Path.home() / ".caracal").resolve(strict=False)


def get_caracal_layout(home: Optional[Path | str] = None, require_explicit: bool = False) -> CaracalLayout:
    """Return resolved layout for current process."""
    if home is None:
        resolved_home = resolve_caracal_home(require_explicit=require_explicit)
    else:
        resolved_home = Path(home).expanduser().resolve(strict=False)
    return CaracalLayout(root=resolved_home)


def _ensure_dir(path: Path, mode: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, mode)
    except OSError as exc:
        raise StorageLayoutError(f"Failed to set permissions on directory {path}: {exc}") from exc


def ensure_layout(layout: CaracalLayout) -> None:
    """Create canonical directory structure and enforce secure defaults."""
    _ensure_dir(layout.root, 0o700)
    _ensure_dir(layout.keystore_dir, 0o700)
    _ensure_dir(layout.workspaces_dir, 0o700)
    _ensure_dir(layout.ledger_dir, 0o700)
    _ensure_dir(layout.merkle_dir, 0o700)
    _ensure_dir(layout.audit_logs_dir, 0o700)
    _ensure_dir(layout.system_dir, 0o700)
    _ensure_dir(layout.metadata_dir, 0o700)
    _ensure_dir(layout.history_dir, 0o700)
