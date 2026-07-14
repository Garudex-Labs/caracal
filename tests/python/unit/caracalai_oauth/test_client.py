"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Python OAuth client tests for cache isolation and STS response validation.
"""

from __future__ import annotations

import asyncio
import unittest
from time import time
from urllib.parse import parse_qs

import httpx

from caracalai_oauth import (
    ApprovalRequired,
    CaracalError,
    ExchangeOptions,
    InMemoryTokenCache,
    OAuthClient,
    TokenExchangeResponse,
)
from caracalai_oauth.client import _json_response


class OAuthClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_one_shot_exchange_bypasses_cache_and_inflight(self) -> None:
        calls = 0

        async def handler(_: httpx.Request) -> httpx.Response:
            nonlocal calls
            calls += 1
            return httpx.Response(
                200,
                json={
                    "access_token": f"token-{calls}",
                    "token_type": "Bearer",
                    "expires_in": 900,
                },
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as http:
            client = OAuthClient("http://sts", "zone", "app", http_client=http)
            tokens = await asyncio.gather(
                client.exchange(
                    "",
                    "resource://pipernet",
                    ExchangeOptions(
                        client_secret="secret", scopes=["read"], cache=False
                    ),
                ),
                client.exchange(
                    "",
                    "resource://pipernet",
                    ExchangeOptions(
                        client_secret="secret", scopes=["read"], cache=False
                    ),
                ),
            )
        self.assertEqual(
            sorted(token.access_token for token in tokens), ["token-1", "token-2"]
        )
        self.assertEqual(calls, 2)

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
                    "approval_id": "challenge1",
                    "approval_type": "human_approval",
                    "acr_values": "urn:mfa",
                    "binding": "abc123",
                    "approval_expires_at": "2026-01-01T00:05:00Z",
                },
                headers={"content-type": "application/json"},
            )

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with self.assertRaises(ApprovalRequired) as raised:
            await client.exchange("subject", "resource://api")
        self.assertEqual(raised.exception.approval_id, "challenge1")
        self.assertEqual(raised.exception.resource, "resource://api")
        self.assertEqual(raised.exception.binding, "abc123")
        self.assertEqual(raised.exception.expires_at, "2026-01-01T00:05:00Z")

    async def test_exchange_sends_approval_id(self) -> None:
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
            ExchangeOptions(approval_id="challenge1"),
        )
        self.assertEqual(seen.get("approval_id"), "challenge1")

    async def test_exchange_does_not_retry_unauthorized(self) -> None:
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

        with self.assertRaisesRegex(CaracalError, "expired client credential"):
            await client.exchange("subject", "resource://api")

        self.assertEqual(requests, 1)

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
                authority_record_id="record",
                session_id="session",
                delegation_id="delegation",
                scopes=["write", "read", "write"],
                ttl_seconds=300,
            ),
        )

        self.assertEqual(captured["scope"], "read+write")
        self.assertEqual(captured["ttl_seconds"], "300")
        self.assertEqual(captured["session_id"], "record")
        self.assertEqual(captured["agent_session_id"], "session")
        self.assertEqual(captured["delegation_edge_id"], "delegation")
        self.assertNotIn("actor_token", captured)
        self.assertNotIn("client_assertion", captured)

    async def test_exchange_does_not_retry_transport_errors(self) -> None:
        attempts = 0

        async def handler(_request: httpx.Request) -> httpx.Response:
            nonlocal attempts
            attempts += 1
            raise httpx.ConnectError("temporary")

        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        )

        with self.assertRaisesRegex(httpx.ConnectError, "temporary"):
            await client.exchange("subject", "resource://api")
        self.assertEqual(attempts, 1)

    async def test_exchange_canonicalizes_resources_and_returns_granted_subset(
        self,
    ) -> None:
        captured: dict[str, list[str]] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(parse_qs(request.content.decode()))
            return httpx.Response(
                200,
                json={
                    "access_token": "token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                    "target_resources": ["resource://a"],
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
            "", [" resource://b ", "resource://a", "resource://b"]
        )

        self.assertEqual(captured["resource"], ["resource://a", "resource://b"])
        self.assertNotIn("subject_token", captured)
        self.assertNotIn("subject_token_type", captured)
        self.assertEqual(token.target_resources, ("resource://a",))

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
        with self.assertRaisesRegex(CaracalError, "bad request"):
            await error_client.exchange("subject", "resource://api")

        malformed_error_client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(
                    lambda _request: httpx.Response(502, json=["bad"])
                )
            ),
        )
        with self.assertRaises(CaracalError) as caught:
            await malformed_error_client.exchange("subject", "resource://api")
        self.assertEqual(caught.exception.http_status, 502)


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


class OAuthHelperTests(unittest.TestCase):
    def test_response_content_type_boundaries(self) -> None:
        self.assertTrue(_json_response(None))
        self.assertTrue(_json_response("APPLICATION/PROBLEM+JSON; charset=utf-8"))
        self.assertFalse(_json_response("text/plain"))


if __name__ == "__main__":
    unittest.main()


class SubjectFederationTests(unittest.IsolatedAsyncioTestCase):
    async def test_federate_subject_posts_id_token_type(self) -> None:
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(
                dict(part.split("=", 1) for part in request.content.decode().split("&"))
            )
            return httpx.Response(
                200,
                json={
                    "access_token": "user-session-token",
                    "token_type": "Bearer",
                    "expires_in": 3600,
                },
            )

        transport = httpx.MockTransport(handler)
        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=transport),
        )
        token = await client.federate_subject(
            "external-id-token", client_secret="secret-1"
        )
        self.assertEqual(token.access_token, "user-session-token")
        self.assertEqual(
            captured["subject_token_type"],
            "urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid_token",
        )
        self.assertNotIn("resource", captured)
        await client.aclose()

    async def test_federate_subject_requires_token(self) -> None:
        client = OAuthClient("https://sts.example.com", "zone1", "app1")
        with self.assertRaises(ValueError):
            await client.federate_subject("")
        await client.aclose()

    async def test_decide_approval_posts_bearer_decision(self) -> None:
        captured: dict[str, object] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured["auth"] = request.headers.get("Authorization")
            captured["path"] = request.url.path
            captured["body"] = request.content.decode()
            return httpx.Response(200)

        transport = httpx.MockTransport(handler)
        client = OAuthClient(
            "https://sts.example.com",
            "zone1",
            "app1",
            http_client=httpx.AsyncClient(transport=transport),
        )
        await client.decide_approval(
            subject_token="user-session-token",
            approval_id="ch-1",
            binding="abcd",
            decision="approved",
            reason="refund reviewed",
        )
        self.assertEqual(captured["auth"], "Bearer user-session-token")
        self.assertEqual(captured["path"], "/approvals/ch-1/decision")
        self.assertIn('"binding":"abcd"', str(captured["body"]))
        with self.assertRaises(ValueError):
            await client.decide_approval(
                subject_token="", approval_id="ch-1", binding="x", decision="approved"
            )
        await client.aclose()
