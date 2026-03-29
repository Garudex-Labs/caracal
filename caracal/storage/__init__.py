"""Storage layout and security helpers for Caracal."""

from .layout import (
    CaracalLayout,
    append_key_audit_event,
    ensure_layout,
    get_caracal_layout,
    resolve_caracal_home,
)

__all__ = [
    "CaracalLayout",
    "append_key_audit_event",
    "ensure_layout",
    "get_caracal_layout",
    "resolve_caracal_home",
]
