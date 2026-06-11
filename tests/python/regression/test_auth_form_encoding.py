# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Regression test: ClientSecretExchanger must serialize multi-resource token-exchange bodies.

import base64
import json
import time
import unittest
from unittest.mock import patch

import httpx

from caracalai.auth import ClientSecretExchanger

_RealClient = httpx.Client


def _jwt_with_exp() -> str:
    header = base64.urlsafe_b64encode(b'{"alg":"none"}').rstrip(b"=").decode("ascii")
    body = (
        base64.urlsafe_b64encode(json.dumps({"exp": time.time() + 3600}).encode())
        .rstrip(b"=")
        .decode("ascii")
    )
    return f"{header}.{body}.sig"


class MultiResourceBodyRegression(unittest.TestCase):
    """A request body built as a list of (key, value) tuples cannot be
    serialized by httpx and raised a TypeError at send time. The body must be
    encoded so repeated `resource` fields survive multi-resource exchanges."""

    def test_multi_resource_body_serializes_with_repeated_fields(self):
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"access_token": _jwt_with_exp()})

        def factory(*args, **kwargs):
            return _RealClient(transport=httpx.MockTransport(handler))

        exchanger = ClientSecretExchanger(
            sts_url="https://sts.example.com",
            zone_id="zone-1",
            application_id="app-1",
            client_secret="secret",
            resources=["urn:res:a", "urn:res:b", "urn:res:c"],
        )

        with patch("caracalai.auth.httpx.Client", factory):
            token = exchanger.get_token()

        self.assertTrue(token)
        body = captured[0].decode()
        self.assertEqual(body.count("resource="), 3)
        self.assertIn("resource=urn%3Ares%3Aa", body)
        self.assertIn("resource=urn%3Ares%3Ac", body)


if __name__ == "__main__":
    unittest.main()
