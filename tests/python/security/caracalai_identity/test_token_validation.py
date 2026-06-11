# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Python identity verify_token security tests for token misuse rejection.

from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.append(str(Path(__file__).parents[3] / "shared" / "test-utils" / "python"))

from caracal_test_tokens import mint_es256_token
from caracalai_identity import verify
from caracalai_identity.verify import ScopeInsufficientError, TokenInvalidError, ZoneInvalidError


class StubCache:
    def __init__(self) -> None:
        self.keys: list[dict[str, object]] = []

    async def get_keys(self, issuer: str, zone_id: str) -> list[dict[str, object]]:
        return self.keys


class TokenValidationSecurityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.cache = StubCache()
        self.original_cache = verify._cache
        verify._cache = self.cache

    async def asyncTearDown(self) -> None:
        verify._cache = self.original_cache

    async def test_rejects_missing_required_scope(self) -> None:
        token, jwk = mint_es256_token(scopes=("read",))
        self.cache.keys = [jwk]

        with self.assertRaises(ScopeInsufficientError):
            await verify.verify_token(
                token,
                "https://sts.example.com",
                "resource://api",
                required_scopes=["write"],
                expected_zone_id="zone1",
            )

    async def test_rejects_zone_mismatch(self) -> None:
        token, jwk = mint_es256_token(zone_id="zone1")
        self.cache.keys = [jwk]

        with self.assertRaises(ZoneInvalidError):
            await verify.verify_token(
                token,
                "https://sts.example.com",
                "resource://api",
                required_scopes=["read"],
                expected_zone_id="zone2",
            )

    async def test_rejects_missing_zone_claim(self) -> None:
        token, jwk = mint_es256_token(zone_id=None)
        self.cache.keys = [jwk]

        with self.assertRaises(ZoneInvalidError):
            await verify.verify_token(token, "https://sts.example.com", "resource://api")

    async def test_rejects_wrong_audience(self) -> None:
        token, jwk = mint_es256_token(audience="resource://other")
        self.cache.keys = [jwk]

        with self.assertRaises(TokenInvalidError):
            await verify.verify_token(token, "https://sts.example.com", "resource://api")


if __name__ == "__main__":
    unittest.main()
