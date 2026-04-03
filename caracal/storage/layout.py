"""Canonical storage layout for Caracal runtime data."""

from __future__ import annotations

import os
import time
from uuid import uuid4
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from caracal.logging_config import get_logger

logger = get_logger(__name__)

_CARACAL_HOME_ENV = "CARACAL_HOME"


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
    1. CARACAL_HOME
    2. ~/.caracal (only when require_explicit=False)
    """
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


def append_key_audit_event(
    layout: CaracalLayout,
    event_type: str,
    actor: str,
    operation: str,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    """Persist key lifecycle events to PostgreSQL audit log."""
    ensure_layout(layout)

    from caracal.config import load_config
    from caracal.db.connection import get_db_manager
    from caracal.db.models import AuditLog

    event_time = datetime.now(timezone.utc)
    offset = time.time_ns()
    payload = {
        "actor": actor,
        "operation": operation,
        "metadata": metadata or {},
    }

    db_manager = get_db_manager(load_config())
    try:
        with db_manager.session_scope() as session:
            session.add(
                AuditLog(
                    event_id=f"key-audit:{offset}:{uuid4().hex[:8]}",
                    event_type=event_type,
                    topic="system.key_audit",
                    partition=0,
                    offset=offset,
                    event_timestamp=event_time,
                    logged_at=event_time,
                    event_data=payload,
                    principal_id=None,
                    correlation_id=None,
                )
            )
    finally:
        db_manager.close()
