# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Python JWKS cache unit tests for issuer lookup and TTL behavior.

from __future__ import annotations

import asyncio
import unittest
from unittest import mock

from caracalai_identity import jwks


class FakeResponse:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = body

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, object]:
        return self.body


class FakeAsyncClient:
    urls: list[str] = []
    body: dict[str, object] = {"keys": [{"kid": "kid1"}]}
    fetch_delay: float = 0.0

    async def __aenter__(self) -> FakeAsyncClient:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        return None

    async def get(self, url: str) -> FakeResponse:
        FakeAsyncClient.urls.append(url)
        if FakeAsyncClient.fetch_delay > 0:
            await asyncio.sleep(FakeAsyncClient.fetch_delay)
        return FakeResponse(FakeAsyncClient.body)


class JwksCacheTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        FakeAsyncClient.urls = []
        FakeAsyncClient.body = {"keys": [{"kid": "kid1"}]}
        FakeAsyncClient.fetch_delay = 0.0
        self.original_client = jwks.httpx.AsyncClient
        jwks.httpx.AsyncClient = FakeAsyncClient

    async def asyncTearDown(self) -> None:
        jwks.httpx.AsyncClient = self.original_client

    async def test_fetches_zone_scoped_jwks_from_issuer(self) -> None:
        cache = jwks.JwksCache()

        keys = await cache.get_keys("https://issuer.example/", "zone1")

        self.assertEqual(keys, [{"kid": "kid1"}])
        self.assertEqual(
            FakeAsyncClient.urls,
            ["https://issuer.example/.well-known/jwks.json?zone_id=zone1"],
        )

    async def test_rejects_missing_zone(self) -> None:
        cache = jwks.JwksCache()

        with self.assertRaises(ValueError):
            await cache.get_keys("https://issuer.example", "")
        self.assertEqual(FakeAsyncClient.urls, [])

    async def test_reuses_cached_keys_for_same_issuer_zone(self) -> None:
        cache = jwks.JwksCache()

        first = await cache.get_keys("https://issuer.example", "zone1")
        FakeAsyncClient.body = {"keys": [{"kid": "kid2"}]}
        second = await cache.get_keys("https://issuer.example", "zone1")

        self.assertIs(first, second)
        self.assertEqual(second, [{"kid": "kid1"}])
        self.assertEqual(len(FakeAsyncClient.urls), 1)

    async def test_distinct_zones_fetch_separately(self) -> None:
        cache = jwks.JwksCache()

        await cache.get_keys("https://issuer.example", "zone1")
        await cache.get_keys("https://issuer.example", "zone2")

        self.assertEqual(
            FakeAsyncClient.urls,
            [
                "https://issuer.example/.well-known/jwks.json?zone_id=zone1",
                "https://issuer.example/.well-known/jwks.json?zone_id=zone2",
            ],
        )

    async def test_concurrent_callers_share_a_single_fetch(self) -> None:
        FakeAsyncClient.fetch_delay = 0.05
        cache = jwks.JwksCache()

        results = await asyncio.gather(
            *[cache.get_keys("https://issuer.example", "zone1") for _ in range(10)]
        )

        for r in results:
            self.assertEqual(r, [{"kid": "kid1"}])
        self.assertEqual(len(FakeAsyncClient.urls), 1)

    async def test_concurrent_callers_for_distinct_issuers_each_fetch_once(
        self,
    ) -> None:
        FakeAsyncClient.fetch_delay = 0.02
        cache = jwks.JwksCache()

        coros = []
        for issuer in ("https://a.example", "https://b.example", "https://c.example"):
            coros.extend([cache.get_keys(issuer, "zone1") for _ in range(5)])
        await asyncio.gather(*coros)

        self.assertEqual(len(FakeAsyncClient.urls), 3)

    async def test_allows_http_for_loopback_issuers(self) -> None:
        cache = jwks.JwksCache()

        for issuer in (
            "http://localhost:4000",
            "http://127.0.0.1:4000",
            "http://[::1]:4000",
        ):
            keys = await cache.get_keys(issuer, "zone1")
            self.assertEqual(keys, [{"kid": "kid1"}])

        self.assertEqual(len(FakeAsyncClient.urls), 3)

    async def test_rejects_http_for_routable_issuers(self) -> None:
        cache = jwks.JwksCache()

        with self.assertRaises(ValueError):
            await cache.get_keys("http://issuer.example", "zone1")
        self.assertEqual(FakeAsyncClient.urls, [])

    async def test_rejects_http_without_a_hostname(self) -> None:
        cache = jwks.JwksCache()

        with self.assertRaises(ValueError):
            await cache.get_keys("http:///jwks", "zone1")
        self.assertEqual(FakeAsyncClient.urls, [])

    async def test_rejects_non_http_schemes(self) -> None:
        cache = jwks.JwksCache()

        for issuer in ("ftp://issuer.example", "issuer.example"):
            with self.assertRaises(ValueError):
                await cache.get_keys(issuer, "zone1")
        self.assertEqual(FakeAsyncClient.urls, [])

    async def test_insecure_override_allows_routable_http_issuers(self) -> None:
        cache = jwks.JwksCache()

        with mock.patch.dict(
            "os.environ", {"CARACAL_ALLOW_INSECURE_CONFIG_URLS": "true"}
        ):
            keys = await cache.get_keys("http://issuer.example", "zone1")

        self.assertEqual(keys, [{"kid": "kid1"}])
        self.assertEqual(
            FakeAsyncClient.urls,
            ["http://issuer.example/.well-known/jwks.json?zone_id=zone1"],
        )


if __name__ == "__main__":
    unittest.main()
