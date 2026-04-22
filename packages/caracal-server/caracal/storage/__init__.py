"""Storage layout and security helpers for Caracal."""

from .key_audit import append_key_audit_event
from .layout import CaracalLayout, ensure_layout, get_caracal_layout, resolve_caracal_home

__all__ = [
    "CaracalLayout",
    "append_key_audit_event",
    "ensure_layout",
    "get_caracal_layout",
    "resolve_caracal_home",
]
