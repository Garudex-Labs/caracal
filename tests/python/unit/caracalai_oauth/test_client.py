"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Python OAuth client tests for cache isolation and STS response validation.
"""

from __future__ import annotations

import asyncio
import unittest
from time import time

import httpx

from caracalai_oauth import (
    ExchangeOptions,
    InMemoryTokenCache,
    InteractionRequiredError,
    OAuthClient,
    TokenExchangeResponse,
)
from caracalai_oauth.client import (
    _backoff,
    _json_response,
    _read_error_response,
    _retry_delay,
    _sleep_within_deadline,
)


class OAuthClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_aclose_only_closes_owned_http_clients(self) -> None:
        owned = OAuthClient("https://sts.example.com", "zone1", "app1")
        await owned.aclose()

        external = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda _request: httpx.Response(200))
        )
        client = OAuthClient(
            "https://sts.example.com", "zone1", "app1", http_client=external
        )
        await client.aclose()
        self.assertFalse(external.is_closed)
        await external.aclose()

    async def test_exchange_does_not_share_cache_across_client_secrets(self) -> None:
        requests: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            form = dict(
                part.split("=", 1) for part in request.content.decode().split("&")
            )
            secret = form.get("client_secret", "")
            requests.append(secret)
            return httpx.Response(
                200,
                json={
                    "access_token": f"token-{secret}",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        first = await client.exchange(
            "subject", "resource://api", ExchangeOptions(client_secret="a")
        )
        second = await client.exchange(
            "subject", "resource://api", ExchangeOptions(client_secret="b")
        )
        third = await client.exchange(
            "subject", "resource://api", ExchangeOptions(client_secret="a")
        )

        self.assertEqual(first.access_token, "token-a")
        self.assertEqual(second.access_token, "token-b")
        self.assertEqual(third.access_token, "token-a")
        self.assertEqual(requests, ["a", "b"])

    async def test_exchange_rejects_malformed_success_response(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={"access_token": "", "token_type": "Bearer", "expires_in": 3600},
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with self.assertRaisesRegex(RuntimeError, "access_token is required"):
            await client.exchange("subject", "resource://api")

    async def test_exchange_rejects_boolean_expiry(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "access_token": "token1",
                    "token_type": "Bearer",
                    "expires_in": True,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with self.assertRaisesRegex(
            RuntimeError, "expires_in must be a positive integer"
        ):
            await client.exchange("subject", "resource://api")

    async def test_exchange_returns_interaction_required_error(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                403,
                json={
                    "error": "interaction_required",
                    "error_description": "step up",
                    "challenge_id": "challenge1",
                    "acr_values": "urn:mfa",
                    "binding": "abc123",
                    "challenge_expires_at": "2026-01-01T00:05:00Z",
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with self.assertRaises(InteractionRequiredError) as raised:
            await client.exchange("subject", "resource://api")
        self.assertEqual(raised.exception.challenge_id, "challenge1")
        self.assertEqual(raised.exception.resource, "resource://api")
        self.assertEqual(raised.exception.binding, "abc123")
        self.assertEqual(raised.exception.expires_at, "2026-01-01T00:05:00Z")

    async def test_exchange_sends_challenge_id(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen.update(
                dict(pair.split("=", 1) for pair in request.content.decode().split("&"))
            )
            return httpx.Response(
                200,
                json={
                    "access_token": "token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        await client.exchange(
            "subject",
            "resource://api",
            ExchangeOptions(challenge_id="challenge1"),
        )
        self.assertEqual(seen.get("challenge_id"), "challenge1")

    async def test_exchange_retries_once_after_unauthorized(self) -> None:
        requests = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal requests
            requests += 1
            if requests == 1:
                return httpx.Response(
                    401,
                    json={"error_description": "expired client credential"},
                    headers={"content-type": "application/json"},
                )
            return httpx.Response(
                200,
                json={
                    "access_token": "fresh",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        token = await client.exchange(
            "subject", "resource://api", ExchangeOptions(retries=0)
        )

        self.assertEqual(token.access_token, "fresh")
        self.assertEqual(requests, 2)

    async def test_concurrent_exchanges_share_inflight_request(self) -> None:
        requests = 0
        gate = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal requests
            requests += 1
            await gate.wait()
            return httpx.Response(
                200,
                json={
                    "access_token": "shared",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com/",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        first = asyncio.create_task(client.exchange("subject", "resource://api"))
        second = asyncio.create_task(client.exchange("subject", "resource://api"))
        await asyncio.sleep(0)
        gate.set()

        tokens = await asyncio.gather(first, second)

        self.assertEqual([token.access_token for token in tokens], ["shared", "shared"])
        self.assertEqual(requests, 1)

    async def test_exchange_sends_scopes_ttl_and_delegation_fields(self) -> None:
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(
                dict(part.split("=", 1) for part in request.content.decode().split("&"))
            )
            return httpx.Response(
                200,
                json={"access_token": "token", "expires_in": 3600},
                headers={"content-type": "application/activity+json"},
            )

        client = OAuthClient(
            "https://sts.example.com/",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )
        await client.exchange(
            "subject",
            "resource://api",
            ExchangeOptions(
                actor_token="actor",
                session_id="sid",
                agent_session_id="agent",
                delegation_edge_id="edge",
                scopes=["write", "read", "write"],
                ttl_seconds=300,
            ),
        )

        self.assertEqual(captured["scope"], "read+write")
        self.assertEqual(captured["ttl_seconds"], "300")
        self.assertEqual(captured["agent_session_id"], "agent")

    async def test_exchange_retries_transient_http_errors_and_statuses(self) -> None:
        attempts = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.ConnectError("temporary")
            if attempts == 2:
                return httpx.Response(
                    429,
                    json={"error_description": "slow"},
                    headers={"retry-after": "0"},
                )
            return httpx.Response(
                200,
                json={
                    "access_token": "fresh",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        token = await client.exchange(
            "subject", "resource://api", ExchangeOptions(retries=2, timeout_ms=1_000)
        )

        self.assertEqual(token.access_token, "fresh")
        self.assertEqual(attempts, 3)

    async def test_exchange_surfaces_timeout_and_non_retryable_errors(self) -> None:
        timeout_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(lambda _request: httpx.Response(200))
            ),
        )
        with self.assertRaisesRegex(TimeoutError, "timed out"):
            await timeout_client.exchange(
                "subject", "resource://api", ExchangeOptions(timeout_ms=-1)
            )

        html_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        200, text="ok", headers={"content-type": "text/html"}
                    )
                )
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "expected application/json"):
            await html_client.exchange("subject", "resource://api")

        list_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        200, json=["bad"], headers={"content-type": "application/json"}
                    )
                )
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "expected JSON object"):
            await list_client.exchange("subject", "resource://api")

        token_type_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        200,
                        json={
                            "access_token": "token",
                            "token_type": "MAC",
                            "expires_in": 1,
                        },
                        headers={"content-type": "application/json"},
                    )
                )
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "token_type must be Bearer"):
            await token_type_client.exchange("subject", "resource://api")

        error_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(
                        400, json={"error_description": "bad request"}
                    )
                )
            ),
        )
        with self.assertRaisesRegex(RuntimeError, "bad request"):
            await error_client.exchange(
                "subject", "resource://api", ExchangeOptions(retries=0)
            )


class InMemoryTokenCacheTests(unittest.TestCase):
    def test_rejects_invalid_size_expires_entries_and_evicts_lru(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive integer"):
            InMemoryTokenCache(0)

        cache = InMemoryTokenCache(max_entries=1)
        expired = TokenExchangeResponse("expired", "Bearer", 1, int(time()) - 10)
        fresh = TokenExchangeResponse("fresh", "Bearer", 3600, int(time()))
        cache.set("subject", "resource://old", expired)
        self.assertIsNone(cache.get("subject", "resource://old"))

        cache.set("subject", "resource://a", fresh)
        cache.set("subject", "resource://b", fresh)
        self.assertIsNone(cache.get("subject", "resource://a"))
        self.assertEqual(cache.get("subject", "resource://b"), fresh)


class OAuthHelperTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_and_backoff_helpers_cover_boundaries(self) -> None:
        self.assertTrue(_json_response(None))
        self.assertTrue(_json_response("APPLICATION/PROBLEM+JSON; charset=utf-8"))
        self.assertFalse(_json_response("text/plain"))

        self.assertEqual(
            _retry_delay(httpx.Response(503, headers={"retry-after": "0.5"}), 0), 0.5
        )
        self.assertEqual(
            _retry_delay(httpx.Response(503, headers={"retry-after": "soon"}), 1),
            _backoff(1),
        )
        self.assertEqual(_backoff(10), 5)

        with self.assertRaisesRegex(TimeoutError, "timed out"):
            await _sleep_within_deadline(1, time() - 1)

        self.assertEqual(_read_error_response(httpx.Response(500, content=b"")), {})
        with self.assertRaisesRegex(RuntimeError, "invalid error response"):
            _read_error_response(httpx.Response(500, json=["bad"]))


if __name__ == "__main__":
    unittest.main()
