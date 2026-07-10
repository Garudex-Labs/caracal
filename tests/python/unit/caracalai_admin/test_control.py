"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

ControlClient unit tests covering scoped token minting, invoke dispatch, and secret-safe error handling.
"""

from __future__ import annotations

import json
import unittest
from urllib.parse import parse_qs

import httpx

from caracalai_admin import ControlClient, ControlClientError


def token_response(token="tok-123"):
    return httpx.Response(
        200, json={"access_token": token, "token_type": "Bearer", "expires_in": 300}
    )


def invoke_response(result):
    return httpx.Response(200, json={"ok": True, "result": result})


def make_client(queue, requests, **overrides):
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    kwargs = {
        "sts_url": "https://sts.example.com",
        "control_url": "https://api.example.com",
        "audience": "caracal-control",
        "application_id": "app-operator",
        "client_secret": "cs_super_secret",
        "http_client": httpx.Client(transport=httpx.MockTransport(handler)),
    }
    kwargs.update(overrides)
    return ControlClient(**kwargs)


def form(request: httpx.Request) -> dict[str, str]:
    return {
        key: values[0] for key, values in parse_qs(request.content.decode()).items()
    }


class ControlInvokeTests(unittest.TestCase):
    def test_mints_scoped_token_then_invokes(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), invoke_response([{"id": "z1"}])], requests
        )

        result = client.invoke("zone", "list", {}, ["control:zone:read"])

        self.assertEqual(result, [{"id": "z1"}])
        self.assertEqual(str(requests[0].url), "https://sts.example.com/oauth/2/token")
        token_form = form(requests[0])
        self.assertEqual(
            token_form["grant_type"],
            "urn:ietf:params:oauth:grant-type:token-exchange",
        )
        self.assertEqual(token_form["application_id"], "app-operator")
        self.assertEqual(token_form["resource"], "caracal-control")
        self.assertEqual(token_form["scope"], "control:zone:read")
        self.assertEqual(
            str(requests[1].url), "https://api.example.com/v1/control/invoke"
        )
        self.assertEqual(requests[1].headers["authorization"], "Bearer tok-123")
        self.assertEqual(
            json.loads(requests[1].content),
            {"command": "zone", "subcommand": "list", "flags": {}},
        )

    def test_joins_scopes_and_forwards_ttl(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), invoke_response({"ok": True})], requests, ttl_seconds=60
        )

        client.invoke(
            "grant",
            "create",
            {"application-id": "a"},
            ["control:grant:write", "control:grant:read"],
        )

        token_form = form(requests[0])
        self.assertEqual(token_form["scope"], "control:grant:write control:grant:read")
        self.assertEqual(token_form["ttl_seconds"], "60")

    def test_rides_authorizing_actor_in_invoke_body(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), invoke_response({"ok": True})],
            requests,
            authorized_by="account-7",
        )

        client.invoke(
            "grant", "create", {"application-id": "a"}, ["control:grant:write"]
        )

        self.assertEqual(
            json.loads(requests[1].content),
            {
                "command": "grant",
                "subcommand": "create",
                "flags": {"application-id": "a"},
                "authorized_by": "account-7",
            },
        )

    def test_trims_trailing_slashes_from_base_urls(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), invoke_response(None)],
            requests,
            sts_url="https://sts.example.com/",
            control_url="https://api.example.com/",
        )

        client.invoke("zone", "list", {}, ["control:zone:read"])

        self.assertEqual(str(requests[0].url), "https://sts.example.com/oauth/2/token")
        self.assertEqual(
            str(requests[1].url), "https://api.example.com/v1/control/invoke"
        )

    def test_token_stage_error_never_calls_invoke(self):
        requests: list[httpx.Request] = []
        denial = httpx.Response(
            403, json={"error": {"code": "access_denied", "reason": "policy denied"}}
        )
        client = make_client([denial], requests)

        with self.assertRaises(ControlClientError) as caught:
            client.invoke("zone", "create", {"name": "x"}, ["control:zone:write"])

        self.assertEqual(caught.exception.stage, "token")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(len(requests), 1)

    def test_invoke_stage_error_carries_structured_denial(self):
        requests: list[httpx.Request] = []
        denial = httpx.Response(
            403,
            json={
                "ok": False,
                "error": {
                    "code": "denied",
                    "reason": "missing scope control:zone:write",
                },
            },
        )
        client = make_client([token_response(), denial], requests)

        with self.assertRaises(ControlClientError) as caught:
            client.invoke("zone", "create", {"name": "x"}, ["control:zone:read"])

        self.assertEqual(caught.exception.stage, "invoke")
        self.assertEqual(caught.exception.code, "denied")
        self.assertEqual(caught.exception.reason, "missing scope control:zone:write")

    def test_empty_access_token_is_a_token_failure(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.Response(200, json={"access_token": ""})], requests)

        with self.assertRaises(ControlClientError):
            client.invoke("zone", "list", {}, ["control:zone:read"])

    def test_does_not_retry_transient_token_failure(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.Response(502, text="upstream boom")], requests)

        with self.assertRaises(ControlClientError):
            client.invoke("zone", "list", {}, ["control:zone:read"])
        self.assertEqual(len(requests), 1)

    def test_does_not_retry_thrown_token_network_failure(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.ConnectError("fetch failed")], requests)

        with self.assertRaises(ControlClientError):
            client.invoke("zone", "list", {}, ["control:zone:read"])
        self.assertEqual(len(requests), 1)

    def test_does_not_retry_denied_token_exchange(self):
        requests: list[httpx.Request] = []
        denial = httpx.Response(
            403, json={"error": {"code": "access_denied", "reason": "policy denied"}}
        )
        client = make_client([denial], requests)

        with self.assertRaises(ControlClientError):
            client.invoke("zone", "list", {}, ["control:zone:read"])
        self.assertEqual(len(requests), 1)

    def test_never_retries_invoke_failure(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), httpx.Response(504, text="gateway timeout")], requests
        )

        with self.assertRaises(ControlClientError) as caught:
            client.invoke("zone", "create", {"name": "x"}, ["control:zone:write"])

        self.assertEqual(caught.exception.stage, "invoke")
        self.assertEqual(len(requests), 2)

    def test_normalizes_thrown_invoke_failure_to_status_zero(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [token_response(), httpx.ConnectError("socket hang up")], requests
        )

        with self.assertRaises(ControlClientError) as caught:
            client.invoke("zone", "create", {"name": "x"}, ["control:zone:write"])

        self.assertEqual(caught.exception.stage, "invoke")
        self.assertEqual(caught.exception.status, 0)
        self.assertIn("socket hang up", caught.exception.reason)

    def test_definitive_classification(self):
        self.assertTrue(ControlClientError("token", 503, "unavailable").definitive)
        self.assertTrue(ControlClientError("token", 0, "network").definitive)
        self.assertTrue(ControlClientError("invoke", 403, "denied").definitive)
        self.assertFalse(ControlClientError("invoke", 504, "timeout").definitive)
        self.assertFalse(ControlClientError("invoke", 0, "network").definitive)

    def test_keeps_client_secret_out_of_error_surfaces(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(502, text="upstream boom"),
                httpx.Response(502, text="upstream boom"),
            ],
            requests,
        )

        with self.assertRaises(ControlClientError) as caught:
            client.invoke("zone", "list", {}, ["control:zone:read"])

        surface = json.dumps(
            {"message": str(caught.exception), "reason": caught.exception.reason}
        )
        self.assertNotIn("cs_super_secret", surface)


if __name__ == "__main__":
    unittest.main()
