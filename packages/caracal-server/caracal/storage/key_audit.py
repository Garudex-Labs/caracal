"""Key lifecycle audit persistence helpers."""

from __future__ import annotations

import time
import importlib
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import uuid4

from caracal.db.connection import get_db_manager
from caracal.db.models import AuditLog

from .layout import CaracalLayout, ensure_layout


def append_key_audit_event(
    layout: CaracalLayout,
    event_type: str,
    actor: str,
    operation: str,
    metadata: Optional[dict[str, Any]] = None,
) -> None:
    """Persist key lifecycle events to the audit log."""
    ensure_layout(layout)

    event_time = datetime.now(timezone.utc)
    offset = time.time_ns()
    payload = {
        "actor": actor,
        "operation": operation,
        "metadata": metadata or {},
    }

    config_module = importlib.import_module("caracal.config.settings")
    db_manager = get_db_manager(config_module.load_config())
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
