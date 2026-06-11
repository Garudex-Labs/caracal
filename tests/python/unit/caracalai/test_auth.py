# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for caracalai.auth client_secret token exchange and caching.

import base64
import json
import time
import unittest
from unittest.mock import patch

import httpx

from caracalai.auth import (
    GRANT_TYPE,
    ClientSecretExchanger,
    _decode_jwt_exp,
)


def _jwt(payload: dict) -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode("ascii")
    body = (
        base64.urlsafe_b64encode(json.dumps(payload).encode())
        .rstrip(b"=")
        .decode("ascii")
    )
    return f"{header}.{body}.sig"


def _exchanger(**overrides) -> ClientSecretExchanger:
    args = dict(
        sts_url="https://sts.example.com/",
        zone_id="zone-1",
        application_id="app-1",
        client_secret="secret",
        resources=["urn:res:a"],
    )
    args.update(overrides)
    return ClientSecretExchanger(**args)


_RealClient = httpx.Client


def _patch_client(handler):
    def factory(*args, **kwargs):
        return _RealClient(transport=httpx.MockTransport(handler))

    return patch("caracalai.auth.httpx.Client", factory)


class DecodeJwtExpTests(unittest.TestCase):
    def test_returns_exp_for_valid_token(self):
        self.assertEqual(_decode_jwt_exp(_jwt({"exp": 1234})), 1234.0)

    def test_returns_none_for_wrong_segment_count(self):
        self.assertIsNone(_decode_jwt_exp("a.b"))

    def test_returns_none_for_bad_base64(self):
        self.assertIsNone(_decode_jwt_exp("h.!!!!.s"))

    def test_returns_none_when_exp_missing(self):
        self.assertIsNone(_decode_jwt_exp(_jwt({"sub": "x"})))

    def test_returns_none_when_exp_not_numeric(self):
        self.assertIsNone(_decode_jwt_exp(_jwt({"exp": "soon"})))


class ConstructorTests(unittest.TestCase):
    def test_rejects_empty_resources(self):
        with self.assertRaises(ValueError):
            _exchanger(resources=[])

    def test_strips_trailing_slash_from_sts_url(self):
        ex = _exchanger(sts_url="https://sts.example.com///")
        self.assertEqual(ex._sts_url, "https://sts.example.com")


class GetTokenTests(unittest.TestCase):
    def test_fetches_and_returns_access_token(self):
        token = _jwt({"exp": time.time() + 3600})

        def handler(req: httpx.Request) -> httpx.Response:
            self.assertTrue(req.url.path.endswith("/oauth/2/token"))
            return httpx.Response(200, json={"access_token": token})

        with _patch_client(handler):
            self.assertEqual(_exchanger().get_token(), token)

    def test_caches_token_without_second_request(self):
        token = _jwt({"exp": time.time() + 3600})
        calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            return httpx.Response(200, json={"access_token": token})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            ex.get_token()
        self.assertEqual(len(calls), 1)

    def test_refreshes_when_token_near_expiry(self):
        first = _jwt({"exp": time.time() + 10})
        second = _jwt({"exp": time.time() + 3600})
        tokens = [first, second]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": tokens.pop(0)})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            self.assertEqual(ex.get_token(), second)

    def test_sends_repeated_resource_fields_and_grant_type(self):
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(
                200, json={"access_token": _jwt({"exp": time.time() + 3600})}
            )

        with _patch_client(handler):
            _exchanger(resources=["urn:a", "urn:b"]).get_token()
        body = captured[0].decode()
        self.assertIn(GRANT_TYPE.replace(":", "%3A"), body)
        self.assertEqual(body.count("resource="), 2)


class RefreshErrorTests(unittest.TestCase):
    def test_raises_on_http_error_status(self):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"error": "boom"})

        with _patch_client(handler):
            with self.assertRaises(httpx.HTTPStatusError):
                _exchanger().get_token()

    def test_raises_when_access_token_missing(self):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"token_type": "bearer"})

        with _patch_client(handler):
            with self.assertRaises(RuntimeError):
                _exchanger().get_token()

    def test_uses_expires_in_when_token_has_no_exp(self):
        token = _jwt({"sub": "x"})

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": token, "expires_in": 1200})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            self.assertGreater(ex._exp, time.time() + 1000)

    def test_falls_back_to_default_ttl_without_exp_or_expires_in(self):
        token = _jwt({"sub": "x"})

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": token})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            self.assertGreater(ex._exp, time.time() + 500)


class MintMandateTests(unittest.TestCase):
    def test_sends_agent_identity_resource_scope_and_ttl(self):
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(
                200, json={"access_token": _jwt({"exp": time.time() + 300})}
            )

        with _patch_client(handler):
            _exchanger().mint_mandate(
                resource="resource://payments",
                scopes=["pay:write", "pay:read"],
                agent_session_id="agent_1",
                delegation_edge_id="edge_1",
                ttl_seconds=120,
            )
        body = captured[0].decode()
        self.assertIn("agent_session_id=agent_1", body)
        self.assertIn("delegation_edge_id=edge_1", body)
        self.assertIn("ttl_seconds=120", body)
        self.assertIn("scope=pay%3Aread+pay%3Awrite", body)
        self.assertIn("resource=resource%3A%2F%2Fpayments", body)
        self.assertIn(GRANT_TYPE.replace(":", "%3A"), body)

    def test_omits_identity_fields_when_absent(self):
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(
                200, json={"access_token": _jwt({"exp": time.time() + 300})}
            )

        with _patch_client(handler):
            _exchanger().mint_mandate(resource="urn:res:a", scopes=["s.read"])
        body = captured[0].decode()
        self.assertNotIn("agent_session_id", body)
        self.assertNotIn("delegation_edge_id", body)
        self.assertNotIn("ttl_seconds", body)

    def test_caches_per_resource_scopes_and_agent(self):
        calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            return httpx.Response(
                200,
                json={"access_token": _jwt({"exp": time.time() + 300, "n": len(calls)})},
            )

        with _patch_client(handler):
            ex = _exchanger()
            first = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.read"], agent_session_id="agent_1"
            )
            again = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.read"], agent_session_id="agent_1"
            )
            other_agent = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.read"], agent_session_id="agent_2"
            )
            other_scope = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.write"], agent_session_id="agent_1"
            )
        self.assertEqual(first, again)
        self.assertNotEqual(first, other_agent)
        self.assertNotEqual(first, other_scope)
        self.assertEqual(len(calls), 3)

    def test_refreshes_mandate_near_expiry(self):
        tokens = [
            _jwt({"exp": time.time() + 10}),
            _jwt({"exp": time.time() + 300}),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": tokens.pop(0)})

        with _patch_client(handler):
            ex = _exchanger()
            stale = ex.mint_mandate(resource="urn:res:a", scopes=["s.read"])
            fresh = ex.mint_mandate(resource="urn:res:a", scopes=["s.read"])
        self.assertNotEqual(stale, fresh)

    def test_rejects_empty_resource_and_scopes(self):
        ex = _exchanger()
        with self.assertRaises(ValueError):
            ex.mint_mandate(resource="", scopes=["s.read"])
        with self.assertRaises(ValueError):
            ex.mint_mandate(resource="urn:res:a", scopes=[])


if __name__ == "__main__":
    unittest.main()
