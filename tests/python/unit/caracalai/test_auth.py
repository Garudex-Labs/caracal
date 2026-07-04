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
    ApprovalRequired,
    ClientCredentials,
    ClientSecretExchanger,
    _decode_jwt_exp,
)
from caracalai.errors import (
    AccessDenied,
    CaracalError,
    ZoneMismatch,
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
        credentials=lambda: ClientCredentials(
            zone_id="zone-1", application_id="app-1", client_secret="secret"
        ),
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
    def test_lifecycle_token_requires_resources(self):
        ex = _exchanger(resources=[])
        with self.assertRaisesRegex(RuntimeError, "no resources configured"):
            ex.get_token()

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
        first = _jwt({"exp": time.time() + 3600})
        second = _jwt({"exp": time.time() + 7200})
        tokens = [first, second]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": tokens.pop(0)})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            with patch("caracalai.auth.time.time", return_value=time.time() + 3590):
                self.assertEqual(ex.get_token(), second)

    def test_caches_short_lived_token_within_half_lifetime(self):
        token = _jwt({"exp": time.time() + 10})
        calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            return httpx.Response(200, json={"access_token": token})

        with _patch_client(handler):
            ex = _exchanger()
            ex.get_token()
            self.assertEqual(ex.get_token(), token)
        self.assertEqual(len(calls), 1)

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
            with self.assertRaises(CaracalError) as caught:
                _exchanger().get_token()
        self.assertEqual(caught.exception.code, "boom")
        self.assertEqual(caught.exception.http_status, 500)

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
                json={
                    "access_token": _jwt({"exp": time.time() + 300, "n": len(calls)})
                },
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

    def test_caches_per_ttl(self):
        calls = []

        def handler(req: httpx.Request) -> httpx.Response:
            calls.append(req)
            return httpx.Response(
                200,
                json={
                    "access_token": _jwt({"exp": time.time() + 300, "n": len(calls)})
                },
            )

        with _patch_client(handler):
            ex = _exchanger()
            short = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.read"], ttl_seconds=60
            )
            long = ex.mint_mandate(
                resource="urn:res:a", scopes=["s.read"], ttl_seconds=3600
            )
        self.assertNotEqual(short, long)
        self.assertEqual(len(calls), 2)

    def test_refreshes_mandate_near_expiry(self):
        tokens = [
            _jwt({"exp": time.time() + 3600}),
            _jwt({"exp": time.time() + 7200}),
        ]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"access_token": tokens.pop(0)})

        with _patch_client(handler):
            ex = _exchanger()
            stale = ex.mint_mandate(resource="urn:res:a", scopes=["s.read"])
            with patch("caracalai.auth.time.time", return_value=time.time() + 3590):
                fresh = ex.mint_mandate(resource="urn:res:a", scopes=["s.read"])
        self.assertNotEqual(stale, fresh)

    def test_rejects_empty_resource_and_scopes(self):
        ex = _exchanger()
        with self.assertRaises(ValueError):
            ex.mint_mandate(resource="", scopes=["s.read"])
        with self.assertRaises(ValueError):
            ex.mint_mandate(resource="urn:res:a", scopes=[])

    def test_raises_approval_required_on_gated_mint(self):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(
                401,
                json={
                    "error": "interaction_required",
                    "challenge_type": "human_approval",
                    "challenge_id": "chal_1",
                    "state": "pending",
                    "tier": "money",
                    "binding": "ab12",
                    "challenge_expires_at": "2026-01-01T00:00:00Z",
                },
            )

        with _patch_client(handler):
            with self.assertRaises(ApprovalRequired) as caught:
                _exchanger().mint_mandate(
                    resource="resource://payments", scopes=["pay:write"]
                )
        self.assertEqual(caught.exception.challenge_id, "chal_1")
        self.assertEqual(caught.exception.expires_at, "2026-01-01T00:00:00Z")
        self.assertEqual(caught.exception.state, "pending")
        self.assertEqual(caught.exception.tier, "money")
        self.assertEqual(caught.exception.binding, "ab12")

    def test_wait_for_approval_long_polls_until_decision(self):
        states = iter(["pending", "approved"])
        seen: list[str] = []

        def handler(req: httpx.Request) -> httpx.Response:
            seen.append(str(req.url))
            return httpx.Response(200, json={"id": "chal_1", "state": next(states)})

        with _patch_client(handler):
            state = _exchanger().wait_for_approval("chal_1", timeout_seconds=60.0)
        self.assertEqual(state, "approved")
        self.assertEqual(len(seen), 2)
        self.assertIn("/step-up/chal_1?wait=", seen[0])

    def test_wait_for_approval_returns_pending_on_timeout(self):
        with _patch_client(lambda req: httpx.Response(200, json={"state": "pending"})):
            state = _exchanger().wait_for_approval("chal_1", timeout_seconds=0.0)
        self.assertEqual(state, "pending")

    def test_wait_for_approval_requires_challenge_id(self):
        with self.assertRaises(ValueError):
            _exchanger().wait_for_approval("")

    def test_sends_challenge_id_when_approval_id_set(self):
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(
                200, json={"access_token": _jwt({"exp": time.time() + 300})}
            )

        with _patch_client(handler):
            _exchanger().mint_mandate(
                resource="resource://payments",
                scopes=["pay:write"],
                approval_id="chal_1",
            )
        self.assertIn("challenge_id=chal_1", captured[0].decode())


class TypedErrorTests(unittest.TestCase):
    def _raise_on(self, status: int, body: dict):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json=body)

        with _patch_client(handler):
            _exchanger().get_token()

    def test_maps_zone_invalid_to_zone_mismatch(self):
        with self.assertRaises(ZoneMismatch) as caught:
            self._raise_on(
                403,
                {
                    "error": "zone_invalid",
                    "error_description": "application is registered in zone zone-1",
                    "requestId": "req-9",
                },
            )
        self.assertEqual(caught.exception.code, "zone_invalid")
        self.assertEqual(caught.exception.request_id, "req-9")
        self.assertEqual(caught.exception.http_status, 403)

    def test_maps_access_denied(self):
        with self.assertRaises(AccessDenied) as caught:
            self._raise_on(
                401, {"error": "access_denied", "error_description": "policy denied"}
            )
        self.assertEqual(caught.exception.description, "policy denied")

    def test_unknown_code_falls_back_to_base_with_code(self):
        with self.assertRaises(CaracalError) as caught:
            self._raise_on(500, {"error": "internal_error"})
        self.assertEqual(type(caught.exception), CaracalError)
        self.assertEqual(caught.exception.code, "internal_error")

    def test_typed_errors_are_caracal_errors(self):
        self.assertTrue(issubclass(ZoneMismatch, CaracalError))
        self.assertTrue(issubclass(ApprovalRequired, CaracalError))

    def test_non_json_error_body_still_raises_caracal_error(self):
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(502, text="bad gateway")

        with _patch_client(handler):
            with self.assertRaises(CaracalError) as caught:
                _exchanger().get_token()
        self.assertEqual(caught.exception.http_status, 502)


class EventTests(unittest.TestCase):
    def test_emits_exchange_events_for_fresh_cached_and_failed(self):
        token = _jwt({"exp": time.time() + 3600})
        requests: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            requests.append(req)
            if len(requests) > 1:
                return httpx.Response(
                    403,
                    json={
                        "error": "access_denied",
                        "error_description": "Denied",
                        "requestId": "req-2",
                    },
                )
            return httpx.Response(200, json={"access_token": token})

        events = []

        def sink(event):
            events.append(event)
            raise RuntimeError("sink failure")

        with _patch_client(handler):
            ex = _exchanger()
            ex.on_event = sink
            ex.get_token()
            ex.get_token()
            with self.assertRaises(AccessDenied):
                ex.mint_mandate(resource="urn:res:a", scopes=["pay:write"])

        self.assertEqual(len(events), 3)
        fresh, cached, failed = events
        self.assertEqual(fresh.type, "token.exchange")
        self.assertTrue(fresh.ok)
        self.assertFalse(fresh.cached)
        self.assertEqual(fresh.resources, ("urn:res:a",))
        self.assertTrue(cached.ok)
        self.assertTrue(cached.cached)
        self.assertFalse(failed.ok)
        self.assertEqual(failed.code, "access_denied")
        self.assertEqual(failed.status, 403)
        self.assertEqual(failed.scopes, ("pay:write",))

    def test_emits_approval_wait_event(self):
        events = []

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"id": "chal_1", "state": "approved"})

        with _patch_client(handler):
            ex = _exchanger()
            ex.on_event = events.append
            state = ex.wait_for_approval("chal_1", timeout_seconds=60.0)

        self.assertEqual(state, "approved")
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].type, "approval.wait")
        self.assertTrue(events[0].ok)
        self.assertEqual(events[0].challenge_id, "chal_1")
        self.assertEqual(events[0].state, "approved")


if __name__ == "__main__":
    unittest.main()
