"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

In-memory revocation store tests for TTL behavior.
"""

from __future__ import annotations

import time
import unittest

from caracalai_revocation import InMemoryRevocationStore


class InMemoryRevocationStoreTests(unittest.TestCase):
    def test_marks_sessions_revoked_until_expiry(self) -> None:
        store = InMemoryRevocationStore(default_ttl_ms=10)

        store.mark_revoked("sid-1")
        self.assertTrue(store.is_revoked("sid-1"))
        time.sleep(0.02)
        self.assertFalse(store.is_revoked("sid-1"))
        self.assertFalse(store.is_revoked("sid-1"))

    def test_explicit_ttl_overrides_default(self) -> None:
        store = InMemoryRevocationStore(default_ttl_ms=60_000)

        store.mark_revoked("sid-1", ttl_ms=1)
        time.sleep(0.01)
        self.assertFalse(store.is_revoked("sid-1"))


if __name__ == "__main__":
    unittest.main()
