# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Interoperability contract tests for shared JSON fixtures.

from __future__ import annotations

import json
from pathlib import Path
import unittest


FIXTURES = Path(__file__).parents[3] / "shared" / "fixtures" / "interoperability"


def read_fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


class InteroperabilityContractTests(unittest.TestCase):
    def test_jwt_claims_fixture_preserves_verifier_contract(self) -> None:
        claims = read_fixture("jwt-claims.resource.valid.json")

        for key in ("iss", "sub", "aud", "exp", "iat", "jti"):
            self.assertIn(key, claims)
        for key in ("zone_id", "client_id", "sid", "root_sid", "use", "sub_type"):
            self.assertIn(key, claims)
        self.assertEqual(claims["use"], "resource")
        self.assertEqual(claims["sub_type"], "user")
        self.assertIn(claims["aud"], claims["target"])
        self.assertEqual(claims["sid"], "authority-record-1")
        self.assertEqual(claims["root_sid"], "authority-record-root")
        self.assertEqual(claims["agent_session_id"], "session-child")
        self.assertEqual(claims["delegation_edge_id"], "delegation-1")
        self.assertEqual(claims["source_session_id"], "session-parent")
        self.assertEqual(claims["target_session_id"], "session-child")

    def test_trace_context_fixture_uses_w3c_headers(self) -> None:
        headers = read_fixture("trace-context.headers.valid.json")

        self.assertRegex(
            str(headers["traceparent"]), r"^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$"
        )
        self.assertIn("tracestate", headers)
        self.assertIn("caracal.agent_session=session-child", str(headers["baggage"]))
        self.assertIn("caracal.hop=1", str(headers["baggage"]))

    def test_gateway_manifest_fixture_declares_enforcement_requirements(self) -> None:
        manifest = read_fixture("gateway-upstream-manifest.http.valid.json")

        self.assertEqual(manifest["schema_version"], "2026-05-21")
        self.assertEqual(manifest["resource_identifier"], "resource://api")
        audit = manifest["audit"]
        self.assertIsInstance(audit, dict)
        self.assertTrue(audit["action_result_required"])

    def test_agent_framework_connector_manifest_labels_enforcement(self) -> None:
        manifest = read_fixture("agent-connector-manifest.valid.json")

        audit = manifest["audit"]
        self.assertIsInstance(audit, dict)
        self.assertTrue(audit["labels_enforcement_mode"])


if __name__ == "__main__":
    unittest.main()
