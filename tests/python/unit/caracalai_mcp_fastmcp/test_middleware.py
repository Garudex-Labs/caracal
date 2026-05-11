# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# CaracalAuth FastMCP adaptor unit tests.

from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.append(str(Path(__file__).parents[3] / "shared" / "test-utils" / "python"))

from caracal_test_tokens import mint_es256_token
from caracalai_identity import verify
from caracalai_mcp_fastmcp import CaracalAuth, CaracalAuthError
from caracalai_revocation import InMemoryRevocationStore


class StubCache:
    def __init__(self) -> None:
        self.keys: list[dict[str, object]] = []

    async def get_keys(self, issuer: str) -> list[dict[str, object]]:
        return self.keys


class CaracalAuthTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.cache = StubCache()
        self.original_cache = verify._cache
        verify._cache = self.cache

    async def asyncTearDown(self) -> None:
        verify._cache = self.original_cache

    async def test_auth_callable_uses_configured_requirements(self) -> None:
        token, jwk = mint_es256_token(scopes=("invoke",), zone_id="zone2")
        self.cache.keys = [jwk]
        auth = CaracalAuth(
            "https://sts.example.com",
            "resource://api",
            InMemoryRevocationStore(),
            required_scopes=["invoke"],
            expected_zone_id="zone2",
        )

        claims = await auth(token)

        self.assertEqual(claims.zone_id, "zone2")


if __name__ == "__main__":
    unittest.main()
