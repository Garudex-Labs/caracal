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
            [
                httpx.Response(
                    200,
                    json={"items": [{"id": "z1", "slug": "demo"}], "next_cursor": None},
                )
            ],
            requests,
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
                    400,
                    json={"error": "invalid_input", "error_description": "bad slug"},
                )
            ],
            requests,
        )

        with self.assertRaises(AdminApiError) as caught:
            client.zones.create({"slug": "!!", "display_name": "x"})

        self.assertEqual(caught.exception.status, 400)
        self.assertEqual(caught.exception.code, "invalid_input")
        self.assertEqual(
            caught.exception.body,
            {"error": "invalid_input", "error_description": "bad slug"},
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
                httpx.Response(
                    200, json={"items": [{"id": "z1"}], "next_cursor": None}
                ),
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
                httpx.Response(200, json={"items": [], "next_cursor": None}),
            ],
            requests,
            retries=1,
        )

        self.assertEqual(client.zones.list(), [])
        self.assertEqual(len(requests), 2)

    def test_covers_provisioning_surface_with_paths_and_methods(self):
        requests: list[httpx.Request] = []
        responses = [httpx.Response(200, json={"items": [], "next_cursor": None})] * 17
        client = make_client(responses, requests)

        client.applications.list("z1")
        client.applications.rotate_secret("z1", "app-1")
        client.applications.get_client_secret("z1", "app-1")
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
        client.policy_sets.list_versions("z1", "set-1")
        client.policy_sets.simulate(
            "z1", "set-1", "setver-1", input={"subject": "richard"}
        )
        client.policy_sets.activate("z1", "set-1", "setver-1")
        client.policy_sets.activation_status(
            "z1", "set-1", version_id="setver-1", outbox_id="outbox-1"
        )
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
            observed[2][:2],
            ("http://api/v1/zones/z1/applications/app-1/client-secret", "GET"),
        )
        self.assertEqual(
            observed[3][:2], ("http://api/v1/zones/z1/applications/dcr", "POST")
        )
        self.assertEqual(observed[4][:2], ("http://api/v1/zones/z1/resources", "POST"))
        self.assertEqual(
            observed[5][:2], ("http://api/v1/zones/z1/providers/prov-1", "PATCH")
        )
        self.assertEqual(observed[6][:2], ("http://api/v1/policies/validate", "POST"))
        self.assertEqual(
            json.loads(observed[6][2]), {"content": "package caracal.authz\n"}
        )
        self.assertEqual(
            observed[7][:2], ("http://api/v1/zones/z1/policies/pol-1/versions", "POST")
        )
        self.assertEqual(
            json.loads(observed[7][2]),
            {"content": "content"},
        )
        self.assertEqual(observed[8][:2], ("http://api/v1/zones/z1/policy-sets", "GET"))
        self.assertEqual(
            observed[9][:2], ("http://api/v1/zones/z1/policy-sets", "POST")
        )
        self.assertEqual(json.loads(observed[9][2]), {"name": "PiperNet set"})
        self.assertEqual(
            json.loads(observed[10][2]),
            {"name": "PiperNet set", "description": "baseline"},
        )
        self.assertEqual(
            observed[11][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/versions", "POST"),
        )
        self.assertEqual(
            json.loads(observed[11][2]), {"manifest": [{"policy_version_id": "ver-1"}]}
        )
        self.assertEqual(
            observed[12][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/versions", "GET"),
        )
        self.assertEqual(
            observed[13][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/simulate", "POST"),
        )
        self.assertEqual(
            json.loads(observed[13][2]),
            {"version_id": "setver-1", "input": {"subject": "richard"}},
        )
        self.assertEqual(
            observed[14][:2],
            ("http://api/v1/zones/z1/policy-sets/set-1/activate", "POST"),
        )
        self.assertEqual(json.loads(observed[14][2]), {"version_id": "setver-1"})
        self.assertEqual(
            observed[15][:2],
            (
                "http://api/v1/zones/z1/policy-sets/set-1/activation-status?version_id=setver-1&outbox_id=outbox-1",
                "GET",
            ),
        )
        self.assertEqual(
            observed[16][:2], ("http://api/v1/zones/z1/policy-sets/set-1", "DELETE")
        )


class AdminOperationsTests(unittest.TestCase):
    def test_grant_list_query_maps_scopes_and_subject_id(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(200, json={"items": [], "next_cursor": None})] * 2,
            requests,
        )

        client.grants.list(
            "z1", {"subject_id": "user:richard", "scopes": ["read", "write"]}
        )
        client.grants.list("z1", {"user_id": "user:monica", "subject_id": "ignored"})

        self.assertEqual(
            str(requests[0].url),
            "http://api/v1/zones/z1/grants?user_id=user%3Arichard&scopes=read%2Cwrite",
        )
        self.assertEqual(
            str(requests[1].url), "http://api/v1/zones/z1/grants?user_id=user%3Amonica"
        )

    def test_policy_template_get_finds_and_raises_not_found(self):
        requests: list[httpx.Request] = []
        templates = [{"id": "tpl-1", "name": "PiperNet baseline"}]
        client = make_client(
            [
                httpx.Response(200, json=templates),
                httpx.Response(200, json=templates),
            ],
            requests,
        )

        self.assertEqual(client.policy_templates.get("tpl-1"), templates[0])
        with self.assertRaises(AdminApiError) as caught:
            client.policy_templates.get("tpl-missing")
        self.assertEqual(caught.exception.status, 404)
        self.assertEqual(caught.exception.code, "policy_template_not_found")
        self.assertEqual(
            caught.exception.body,
            {"error": "policy_template_not_found", "id": "tpl-missing"},
        )
        self.assertEqual(str(requests[0].url), "http://api/v1/policy-templates")

    def test_listing_unwraps_and_validates_items(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    200, json={"items": [{"id": "s1"}], "next_cursor": None}
                ),
                httpx.Response(200, json={"next_cursor": None}),
            ],
            requests,
        )

        self.assertEqual(
            client.authority_records.list("z1", {"status": "active"}),
            [{"id": "s1"}],
        )
        self.assertEqual(
            str(requests[0].url),
            "http://api/v1/zones/z1/authority-records?status=active",
        )
        with self.assertRaises(RuntimeError) as caught:
            client.sessions.list("z1")
        self.assertEqual(str(caught.exception), "sessions response missing items")

    def test_list_drains_cursors_to_the_complete_collection(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    200, json={"items": [{"id": "app-1"}], "next_cursor": "c1"}
                ),
                httpx.Response(
                    200, json={"items": [{"id": "app-2"}], "next_cursor": "c2"}
                ),
                httpx.Response(
                    200, json={"items": [{"id": "app-3"}], "next_cursor": None}
                ),
            ],
            requests,
        )

        out = client.applications.list("z1")

        self.assertEqual(out, [{"id": "app-1"}, {"id": "app-2"}, {"id": "app-3"}])
        self.assertEqual(str(requests[0].url), "http://api/v1/zones/z1/applications")
        self.assertEqual(
            str(requests[1].url), "http://api/v1/zones/z1/applications?cursor=c1"
        )
        self.assertEqual(
            str(requests[2].url), "http://api/v1/zones/z1/applications?cursor=c2"
        )

    def test_list_refuses_a_cursor_chain_that_never_terminates(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    200, json={"items": [{"id": "app-1"}], "next_cursor": "again"}
                )
            ]
            * 50,
            requests,
        )

        with self.assertRaises(RuntimeError) as caught:
            client.applications.list("z1")
        self.assertEqual(
            str(caught.exception), "applications pagination did not terminate"
        )

    def test_audit_surface_paths(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(200, json={"items": []}),
                httpx.Response(200, json={"items": []}),
                httpx.Response(200, json=[]),
                httpx.Response(200, json={"request_id": "req-1"}),
            ],
            requests,
        )

        client.audit.list("z1", {"decision": "deny"})
        client.admin_audit.list("z1")
        client.audit.by_request("z1", "req-1")
        client.audit.explain("z1", "req-1")

        self.assertEqual(
            str(requests[0].url), "http://api/v1/zones/z1/audit?decision=deny"
        )
        self.assertEqual(str(requests[1].url), "http://api/v1/zones/z1/admin-audit")
        self.assertEqual(
            str(requests[2].url), "http://api/v1/zones/z1/audit/by-request/req-1"
        )
        self.assertEqual(
            str(requests[3].url),
            "http://api/v1/zones/z1/audit/by-request/req-1/explain",
        )

    def test_step_up_decisions_send_reason_only_when_present(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.Response(200, json={})] * 2, requests)

        client.step_up_challenges.approve("z1", "ch-1")
        client.step_up_challenges.reject("z1", "ch-1", reason="policy violation")

        self.assertEqual(
            str(requests[0].url),
            "http://api/v1/zones/z1/step-up-challenges/ch-1/approve",
        )
        self.assertEqual(json.loads(requests[0].content), {})
        self.assertEqual(
            str(requests[1].url),
            "http://api/v1/zones/z1/step-up-challenges/ch-1/reject",
        )
        self.assertEqual(
            json.loads(requests[1].content), {"reason": "policy violation"}
        )

    def test_provider_connections_paths(self):
        requests: list[httpx.Request] = []
        client = make_client([httpx.Response(200, json={})] * 3, requests)

        client.provider_connections.create("z1", {"subject_id": "user:richard"})
        client.provider_connections.authorize_oauth(
            "z1", {"subject_id": "user:richard"}
        )
        client.provider_connections.revoke("z1", {"subject_id": "user:richard"})

        self.assertEqual(
            str(requests[0].url), "http://api/v1/zones/z1/provider-connections"
        )
        self.assertEqual(
            str(requests[1].url),
            "http://api/v1/zones/z1/provider-connections/oauth/authorize",
        )
        self.assertEqual(
            str(requests[2].url), "http://api/v1/zones/z1/provider-connections/revoke"
        )
        self.assertTrue(all(req.method == "POST" for req in requests))

    def test_subjects_revoke_path(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(
                    200,
                    json={
                        "subject_id": "auth0|507f1f77bcf86cd799439011",
                        "authority_records": 2,
                        "sessions": 1,
                        "delegations": 1,
                        "connections": 1,
                    },
                )
            ],
            requests,
        )

        result = client.subjects.revoke(
            "z1",
            {
                "subject_id": "auth0|507f1f77bcf86cd799439011",
                "reason": "credential compromise",
            },
        )

        self.assertEqual(str(requests[0].url), "http://api/v1/zones/z1/subjects/revoke")
        self.assertEqual(requests[0].method, "POST")
        self.assertEqual(
            json.loads(requests[0].content),
            {
                "subject_id": "auth0|507f1f77bcf86cd799439011",
                "reason": "credential compromise",
            },
        )
        self.assertEqual(result["authority_records"], 2)
        self.assertEqual(result["sessions"], 1)

    def test_workload_surface_paths_and_custody_secret(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(200, json={"items": [], "next_cursor": None}),
                httpx.Response(200, json={"id": "wl1"}),
                httpx.Response(
                    200, json={"id": "wl1", "name": "launcher", "secret": "ws_created"}
                ),
                httpx.Response(200, json={"id": "wl1", "name": "launcher-2"}),
                httpx.Response(200, json={"id": "wl1", "secret": "ws_rotated"}),
                httpx.Response(200, json={"secret": "ws_revealed"}),
                httpx.Response(204),
            ],
            requests,
        )

        client.workloads.list("z1")
        client.workloads.get("z1", "wl1")
        created = client.workloads.create("z1", {"name": "launcher"})
        client.workloads.update("z1", "wl1", {"name": "launcher-2"})
        rotated = client.workloads.rotate_secret("z1", "wl1")
        revealed = client.workloads.get_secret("z1", "wl1")
        client.workloads.delete("z1", "wl1")

        self.assertEqual(created["secret"], "ws_created")
        self.assertEqual(rotated["secret"], "ws_rotated")
        self.assertEqual(revealed["secret"], "ws_revealed")
        self.assertEqual(str(requests[0].url), "http://api/v1/zones/z1/workloads")
        self.assertEqual(str(requests[1].url), "http://api/v1/zones/z1/workloads/wl1")
        self.assertEqual(requests[2].method, "POST")
        self.assertEqual(json.loads(requests[2].content), {"name": "launcher"})
        self.assertEqual(requests[3].method, "PUT")
        self.assertEqual(json.loads(requests[3].content), {"name": "launcher-2"})
        self.assertEqual(
            str(requests[4].url),
            "http://api/v1/zones/z1/workloads/wl1/rotate-secret",
        )
        self.assertEqual(requests[4].method, "POST")
        self.assertEqual(
            str(requests[5].url), "http://api/v1/zones/z1/workloads/wl1/secret"
        )
        self.assertEqual(requests[5].method, "GET")
        self.assertEqual(requests[6].method, "DELETE")

    def test_session_listing_and_management_use_their_own_transports(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [
                httpx.Response(200, json={"items": [{"id": "a1"}]}),
                httpx.Response(
                    200,
                    json={
                        "items": [
                            {
                                "agent_session_id": "a2",
                                "parent_id": "a1",
                                "subject_authority_record_id": "record-1",
                            }
                        ]
                    },
                ),
                httpx.Response(200, json={"suspended": True}),
                httpx.Response(204),
                httpx.Response(200, json={"agent_session_id": "a1"}),
                httpx.Response(200, json={"items": [], "next_cursor": None}),
                httpx.Response(200, json={"revoked_edges": 1}),
            ],
            requests,
            coordinator_url="http://coord/",
            coordinator_token="ct",
        )

        sessions = client.sessions.list("z1", {"status": "active"})
        children = client.sessions.children("z1", "a1")
        client.sessions.suspend("z1", "a1")
        client.sessions.terminate("z1", "a1")
        client.sessions.effective_authority("z1", "a1")
        client.delegations.active("z1")
        revocation = client.delegations.revoke("z1", "edge-1")

        self.assertEqual(sessions, [{"id": "a1"}])
        self.assertEqual(
            children,
            [
                {
                    "session_id": "a2",
                    "parent_session_id": "a1",
                    "authority_record_id": "record-1",
                }
            ],
        )
        self.assertEqual(
            str(requests[0].url), "http://api/v1/zones/z1/sessions?status=active"
        )
        self.assertEqual(requests[0].headers["authorization"], "Bearer t")
        self.assertEqual(
            str(requests[1].url), "http://coord/zones/z1/agents/a1/children"
        )
        self.assertEqual(
            (str(requests[2].url), requests[2].method),
            ("http://coord/zones/z1/agents/a1/suspend", "PATCH"),
        )
        self.assertEqual(
            (str(requests[3].url), requests[3].method),
            ("http://coord/zones/z1/agents/a1", "DELETE"),
        )
        self.assertEqual(
            str(requests[4].url),
            "http://coord/zones/z1/agents/a1/effective-authority",
        )
        self.assertEqual(
            str(requests[5].url), "http://coord/zones/z1/delegations/active"
        )
        self.assertEqual(
            (str(requests[6].url), requests[6].method),
            ("http://coord/zones/z1/delegations/edge-1/revoke", "PATCH"),
        )
        self.assertEqual(revocation, {"revoked_delegations": 1})

    def test_coordinator_surfaces_require_configuration(self):
        client = make_client([], [])

        with self.assertRaises(RuntimeError) as caught:
            client.sessions.get("z1", "session-1")
        self.assertEqual(str(caught.exception), "coordinator_url_not_configured")

        client = make_client([], [], coordinator_url="http://coord")
        with self.assertRaises(RuntimeError) as caught:
            client.delegations.active("z1")
        self.assertEqual(str(caught.exception), "coordinator_token_not_configured")

    def test_sessions_list_validates_items(self):
        client = make_client(
            [httpx.Response(200, json={"next_cursor": None})],
            [],
        )

        with self.assertRaises(RuntimeError) as caught:
            client.sessions.list("z1")
        self.assertEqual(str(caught.exception), "sessions response missing items")

    def test_coordinator_errors_carry_target(self):
        client = make_client(
            [httpx.Response(404, json={"error": "agent_not_found"})],
            [],
            retries=0,
            coordinator_url="http://coord",
            coordinator_token="ct",
        )

        with self.assertRaises(AdminApiError) as caught:
            client.sessions.get("z1", "a1")
        self.assertEqual(caught.exception.target, "coordinator")
        self.assertEqual(caught.exception.code, "agent_not_found")

    def test_with_default_headers_merges_over_defaults(self):
        requests: list[httpx.Request] = []
        client = make_client(
            [httpx.Response(200, json={"items": [], "next_cursor": None})],
            requests,
            headers={"x-request-id": "base", "x-tenant": "piedpiper"},
        )

        derived = client.with_default_headers({"x-request-id": "override"})
        derived.zones.list()

        self.assertEqual(requests[0].headers["x-request-id"], "override")
        self.assertEqual(requests[0].headers["x-tenant"], "piedpiper")
        self.assertEqual(requests[0].headers["authorization"], "Bearer t")


if __name__ == "__main__":
    unittest.main()
