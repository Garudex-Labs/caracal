"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Transport MCP authentication tests for bearer parsing, revocation, and delegation errors.
"""

from __future__ import annotations

from pathlib import Path
import sys
import unittest

sys.path.append(str(Path(__file__).parents[3] / "shared" / "test-utils" / "python"))

from caracal_test_tokens import mint_es256_token
from caracalai_identity import verify
from caracalai_revocation import InMemoryRevocationStore
from caracalai_transport_mcp import authenticate, extract_bearer


class StubCache:
    def __init__(self) -> None:
        self.keys: list[dict[str, object]] = []

    async def get_keys(self, issuer: str) -> list[dict[str, object]]:
        return self.keys


class TransportMcpAuthenticateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.cache = StubCache()
        self.original_cache = verify._cache
        verify._cache = self.cache

    async def asyncTearDown(self) -> None:
        verify._cache = self.original_cache

    def test_extract_bearer(self) -> None:
        self.assertEqual(extract_bearer("Bearer token-1"), "token-1")
        self.assertIsNone(extract_bearer("bearer token-1"))
        self.assertIsNone(extract_bearer("Bearer   "))
        self.assertIsNone(extract_bearer(None))

    async def test_rejects_missing_token_without_verification(self) -> None:
        result = await authenticate(
            "",
            "https://sts.example.com",
            "resource://api",
            [],
            "zone1",
            InMemoryRevocationStore(),
        )

        self.assertEqual(result.error.code if result.error else None, "missing_token")

    async def test_rejects_revoked_session_after_verification(self) -> None:
        token, jwk = mint_es256_token(claims={"sid": "sid-1"})
        self.cache.keys = [jwk]
        revocations = InMemoryRevocationStore()
        revocations.mark_revoked("sid-1")

        result = await authenticate(
            token,
            "https://sts.example.com",
            "resource://api",
            [],
            "zone1",
            revocations,
        )

        self.assertEqual(result.error.code if result.error else None, "session_revoked")

    async def test_requires_delegation_chain_membership(self) -> None:
        token, jwk = mint_es256_token(claims={"delegation_chain": [{"app": "app-child"}]})
        self.cache.keys = [jwk]

        result = await authenticate(
            token,
            "https://sts.example.com",
            "resource://api",
            [],
            "zone1",
            InMemoryRevocationStore(),
            require_chain_contains=["app-parent"],
        )

        self.assertEqual(result.error.code if result.error else None, "chain_mismatch")


if __name__ == "__main__":
    unittest.main()
