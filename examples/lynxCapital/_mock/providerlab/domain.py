"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Domain entry point that loads every provider module and re-exports the shared state, context, and dispatch contract.
"""

from __future__ import annotations

from importlib import import_module

import_module("_mock.providerlab.providers")
from _mock.providerlab.providers.base import (
    Ctx,
    DomainError,
    State,
    dispatch,
    new_id,
    now,
)

__all__ = ["Ctx", "DomainError", "State", "dispatch", "new_id", "now"]
