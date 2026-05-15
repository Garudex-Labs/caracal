# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for caracalai_core.logging structured JSON emission and redaction.

import io
import json
import logging
import unittest
from contextlib import redirect_stderr

from caracalai_core.logging import (
    REDACT_VALUE,
    SECRET_KEYS,
    create_logger,
    is_secret_key,
    redact,
)


def _reset() -> None:
    for name in list(logging.Logger.manager.loggerDict):
        if name.startswith("caracal."):
            lg = logging.getLogger(name)
            for h in list(lg.handlers):
                lg.removeHandler(h)


def _capture(fn) -> list[dict]:
    _reset()
    buf = io.StringIO()
    with redirect_stderr(buf):
        fn()
    lines = [l for l in buf.getvalue().strip().splitlines() if l]
    return [json.loads(l) for l in lines]


class LoggingTests(unittest.TestCase):
    def tearDown(self) -> None:
        _reset()

    def test_emits_structured_json(self):
        out = _capture(lambda: create_logger("api", "info").info("ready", port=3000))
        self.assertEqual(out[-1]["level"], "info")
        self.assertEqual(out[-1]["service"], "api")
        self.assertEqual(out[-1]["msg"], "ready")
        self.assertEqual(out[-1]["port"], 3000)

    def test_filters_below_level(self):
        def go():
            log = create_logger("sts", "warn")
            log.info("hidden")
            log.error("visible")
        out = _capture(go)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["msg"], "visible")

    def test_with_propagates_context(self):
        out = _capture(lambda: create_logger("api", "info").with_(request_id="r1", zone_id="z1").info("ok"))
        self.assertEqual(out[-1]["request_id"], "r1")
        self.assertEqual(out[-1]["zone_id"], "z1")

    def test_redacts_secret_fields(self):
        out = _capture(lambda: create_logger("api", "info").info("login", user="alice", password="hunter2", api_key="k"))
        self.assertEqual(out[-1]["user"], "alice")
        self.assertEqual(out[-1]["password"], REDACT_VALUE)
        self.assertEqual(out[-1]["api_key"], REDACT_VALUE)

    def test_with_redacts_bound_secrets(self):
        out = _capture(lambda: create_logger("api", "info").with_(access_token="t").info("ok"))
        self.assertEqual(out[-1]["access_token"], REDACT_VALUE)

    def test_redact_handles_nested(self):
        out = redact({
            "ok": 1,
            "Authorization": "Bearer x",
            "nested": {"secret": "s", "keep": 2},
            "list": [{"token": "t"}, {"keep": "v"}],
        })
        self.assertEqual(out, {
            "ok": 1,
            "Authorization": REDACT_VALUE,
            "nested": {"secret": REDACT_VALUE, "keep": 2},
            "list": [{"token": REDACT_VALUE}, {"keep": "v"}],
        })

    def test_is_secret_key_substring_case_insensitive(self):
        self.assertTrue(is_secret_key("X-Auth-Token"))
        self.assertTrue(is_secret_key("user_password"))
        self.assertFalse(is_secret_key("zone_id"))

    def test_secret_keys_contains_password(self):
        self.assertIn("password", SECRET_KEYS)


if __name__ == "__main__":
    unittest.main()

