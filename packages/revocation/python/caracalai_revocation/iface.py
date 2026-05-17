# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Revocation store contract for resource servers consulting caracal.sessions.revoke.

from __future__ import annotations

from typing import Protocol


class RevocationStore(Protocol):
    def is_revoked(self, sid: str) -> bool:
        pass

    def mark_revoked(self, sid: str, ttl_ms: int | None = None) -> None:
        pass
