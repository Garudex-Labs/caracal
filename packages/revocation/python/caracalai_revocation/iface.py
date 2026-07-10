# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Revocation store contract for resource servers consulting caracal.sessions.revoke.

from __future__ import annotations

from typing import Protocol, runtime_checkable


class RevocationStore(Protocol):
    def is_revoked(self, anchor_id: str) -> bool:
        pass

    def mark_revoked(self, anchor_id: str, ttl_ms: int | None = None) -> None:
        pass


@runtime_checkable
class DelegationEpochStore(Protocol):
    def current_delegation_epoch(self, zone_id: str) -> int:
        pass

    def mark_delegation_epoch(
        self, zone_id: str, epoch: int, ttl_ms: int | None = None
    ) -> None:
        pass
