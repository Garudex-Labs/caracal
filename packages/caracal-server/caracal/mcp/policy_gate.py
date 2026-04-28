"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Passthrough handler for policy-gate tool registrations.
"""
from __future__ import annotations

def passthrough(**kwargs: object) -> dict[str, object]:
    """Return success so the authority check result is the enforcement decision."""
    kwargs.pop("principal_id", None)
    return {"result": "authorized", "args": kwargs}
