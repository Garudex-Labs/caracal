"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Caracal partnership terms a mandate-verifying provider is configured with: accepted resource-view audiences and scope-to-operation grants.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass

ENV = "LYNX_CARACAL_PARTNERSHIP"

_cache: tuple[str, dict[str, "Partnership"]] | None = None


@dataclass(frozen=True)
class Partnership:
    """One provider's signed-off partnership terms with a Caracal zone."""

    audiences: dict[str, tuple[str, ...]]
    scopes: dict[str, tuple[str, ...]]

    def granted_for(self, audience: str) -> set[str]:
        """The Caracal scopes the partnered resource view exposes. A gateway-narrowed
        mandate is audienced to one view and carries no scope claim; the view's
        partnership terms are the scopes it authorizes."""
        return set(self.audiences.get(audience, ()))

    def operations_for(self, granted: set[str]) -> set[str]:
        """Every operation the granted Caracal scopes authorize."""
        operations: set[str] = set()
        for scope in granted:
            operations.update(self.scopes.get(scope, ()))
        return operations


def manifest() -> dict[str, Partnership]:
    """The partnership terms per provider id, parsed from the operator-supplied
    environment so the lab fails closed when no partnership is configured."""
    global _cache
    raw = os.environ.get(ENV, "").strip()
    if _cache is not None and _cache[0] == raw:
        return _cache[1]
    parsed: dict[str, Partnership] = {}
    if raw:
        for provider_id, entry in json.loads(raw).items():
            parsed[provider_id] = Partnership(
                audiences={a: tuple(s) for a, s in entry.get("audiences", {}).items()},
                scopes={s: tuple(ops) for s, ops in entry.get("scopes", {}).items()},
            )
    _cache = (raw, parsed)
    return parsed


def for_provider(provider_id: str) -> Partnership | None:
    return manifest().get(provider_id)
