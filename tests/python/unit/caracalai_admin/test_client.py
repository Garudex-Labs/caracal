"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

AdminClient unit tests covering request shape, query encoding, retry behavior, and error mapping.
"""

from __future__ import annotations

import json
import unittest
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime

import httpx

from caracalai_admin import AdminApiError, AdminClient


def make_client(queue, requests, **overrides):
    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    kwargs = {
        "api_url": "http://api",
        "admin_token": "t",
        "http_client": httpx.Client(transport=httpx.MockTransport(handler)),
    }
    kwargs.update(overrides)
    return AdminClient(**kwargs)


class AdminClientTests(unittest.TestCase):
    def test_sends_bearer_token_and_parses_json(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(200, json=[{"id": "z1", "slug": "demo"}])], requests
        )

        out = client.zones.list()

        self.assertEqual(out, [{"id": "z1", "slug": "demo"}])
        self.assertEqual(str(requests[0].url), "http://api/v1/zones")
        self.assertEqual(requests[0].headers["authorization"], "Bearer t")

    def test_encodes_query_and_skips_empty_values(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(200, json=[])], requests, api_url="http://api/"
        )

        client._request(
            "/v1/zones",
            query={"decision": "deny", "limit": 50, "since": None, "label": ""},
        )

        self.assertEqual(
            str(requests[0].url), "http://api/v1/zones?decision=deny&limit=50"
        )

    def test_serializes_json_body_with_content_type(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(200, json={"id": "z2", "slug": "new"})], requests
        )

        client.zones.create({"slug": "new", "display_name": "New Zone"})

        self.assertEqual(requests[0].method, "POST")
        self.assertEqual(requests[0].headers["content-type"], "application/json")
        self.assertEqual(
            json.loads(requests[0].content), {"slug": "new", "display_name": "New Zone"}
        )

    def test_dcr_status_and_zone_shutdown_patch(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    200,
                    json={"id": "z1", "dcr_enabled": False, "live_dcr_applications": 2},
                ),
                httpx.Response(200, json={"id": "z1"}),
            ],
            requests,
        )

        client.zones.dcr_status("z1")
        client.zones.patch("z1", {"dcr_enabled": False, "dcr_shutdown": "revoke_live"})

        self.assertEqual(str(requests[0].url), "http://api/v1/zones/z1/dcr-status")
        self.assertEqual(str(requests[1].url), "http://api/v1/zones/z1")
        self.assertEqual(requests[1].method, "PATCH")
        self.assertEqual(
            json.loads(requests[1].content),
            {"dcr_enabled": False, "dcr_shutdown": "revoke_live"},
        )

    def test_returns_none_for_expect_empty(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.Response(204)], requests)

        self.assertIsNone(client.zones.delete("z1"))
        self.assertEqual(requests[0].method, "DELETE")

    def test_raises_admin_api_error_with_parsed_body_and_code(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    400, json={"error": "invalid_input", "detail": "bad slug"}
                )
            ],
            requests,
        )

        with self.assertRaises(AdminApiError) as caught:
            client.zones.create({"slug": "!!", "display_name": "x"})

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_input")
        self.assertEqual(
            caught.exception.body, {"error": "invalid_input", "detail": "bad slug"}
        )

    def test_falls_back_to_reason_phrase_when_not_json(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(500, text="<html>nope</html>")], requests, retries=0
        )

        with self.assertRaises(AdminApiError) as caught:
            client.zones.list()

        self.assertEqual(caught.exception.status, 500)
        self.assertEqual(caught.exception.code, "Internal Server Error")

    def test_retries_transient_get_failures(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    503, json={"error": "unavailable"}, headers={"retry-after": "0"}
                ),
                httpx.Response(200, json=[{"id": "z1"}]),
            ],
            requests,
            retries=1,
        )

        self.assertEqual(client.zones.list(), [{"id": "z1"}])
        self.assertEqual(len(requests), 2)

    def test_does_not_retry_mutating_requests(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(503, json={"error": "unavailable"})], requests, retries=3
        )

        with self.assertRaises(AdminApiError) as caught:
            client.zones.create({"name": "Demo"})

        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(requests), 1)

    def test_honours_date_based_retry_after(self):
        when = format_datetime(datetime.now(UTC) + timedelta(milliseconds=10))
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(429, json={}, headers={"retry-after": when}),
                httpx.Response(200, json=[]),
            ],
            requests,
            retries=1,
        )

        self.assertEqual(client.zones.list(), [])
        self.assertEqual(len(requests), 2)

    def test_covers_provisioning_surface_with_paths_and_methods(self):
        requests: list[httpx.Request] = []
        responses = [httpx.Response(200, json={})] * 14
        client = make_client(responses, requests)

        client.applications.list("z1")
        client.applications.rotate_secret("z1", "app-1")
        client.applications.dcr("z1", {"name": "ephemeral"})
        client.resources.create(
            "z1", {"name": "PiperNet", "identifier": "resource://pipernet"}
        )
        client.providers.patch("z1", "prov-1", {"config_json": {}})
        client.policies.validate("package caracal.authz\n")
        client.policies.add_version("z1", "pol-1", "content")
        client.policy_sets.list("z1")
        client.policy_sets.create("z1", "PiperNet set")
        client.policy_sets.create("z1", "PiperNet set", description="baseline")
        client.policy_sets.add_version("z1", "set-1", [{"policy_version_id": "ver-1"}])
        client.policy_sets.simulate(
            "z1", "set-1", "setver-1", input={"subject": "richard"}
        )
        client.policy_sets.activate("z1", "set-1", "setver-1")
        client.policy_sets.delete("z1", "set-1")

        observed = [(str(req.url), req.method, req.content) for req in requests]
        self.assertEqual(
            observed[0][:2], ("http://api/v1/zones/z1/applications", "GET")
        )
        self.assertEqual(
            observed[1][:2],
            ("http://api/v1/zones/z1/applications/app-1/rotate-secret", "POST"),
        )
        self.assertEqual(
            observed[2][:2], ("http://api/v1/zones/z1/applications/dcr", "POST")
        )
        self.assertEqual(observed[3][:2], ("http://api/v1/zones/z1/resources", "POST"))
        self.assertEqual(
            observed[4][:2], ("http://api/v1/zones/z1/providers/prov-1", "PATCH")
        )
        self.assertEqual(observed[5][:2], ("http://api/v1/policies/validate", "POST"))
        self.assertEqual(
            json.loads(observed[5][2]), {"content": "package caracal.authz\n"}
        )
        self.assertEqual(
            observed[6][:2], ("http://api/v1/zones/z1/policies/pol-1/versions", "POST")
        )
        self.assertEqual(
            json.loads(observed[6][2]),
            {"content": "content", "schema_version": "2026-05-20"},
        )
        self.assertEqual(observed[7][:2], ("http://api/v1/zones/z1/policy-sets", "GET"))
        self.assertEqual(
            observed[8][:2], ("http://api/v1/zones/z1/policy-sets", "POST")
        )
        self.assertEqual(json.loads(observed[8][2]), {"name": "PiperNet set"})
        self.assertEqual(
            json.loads(observed[9][2]),
            {"name": "PiperNet set", "description": "baseline"},
        )
        self.assertEqual(
            observed[10][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/versions", "POST"),
        )
        self.assertEqual(
            json.loads(observed[10][2]), {"manifest": [{"policy_version_id": "ver-1"}]}
        )
        self.assertEqual(
            observed[11][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/simulate", "POST"),
        )
        self.assertEqual(
            json.loads(observed[11][2]),
            {"version_id": "setver-1", "input": {"subject": "richard"}},
        )
        self.assertEqual(
            observed[12][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/activate", "POST"),
        )
        self.assertEqual(json.loads(observed[12][2]), {"version_id": "setver-1"})
        self.assertEqual(
            observed[13][:2], ("http://api/v1/zones/z1/policy-sets/set-1", "DELETE")
        )


if __name__ == "__main__":
    unittest.main()
