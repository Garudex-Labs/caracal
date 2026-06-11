# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for caracalai_core.logging structured JSON emission and redaction.

import io
import importlib
import json
import logging
import unittest
from contextlib import redirect_stderr
from unittest.mock import patch

from caracalai_core.logging import (
    REDACT_VALUE,
    SECRET_KEYS,
    create_logger,
    current_trace,
    bind_trace,
    dropped_log_records,
    is_secret_key,
    install_shutdown_handler,
    parse_traceparent,
    redact,
    reset_trace,
    shutdown_logging,
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
        caracal_logging = importlib.import_module("caracalai_core.logging")
        caracal_logging.flush_for_test()
    lines = [l for l in buf.getvalue().strip().splitlines() if l]
    return [json.loads(l) for l in lines]


class LoggingTests(unittest.TestCase):
    def tearDown(self) -> None:
        shutdown_logging()
        _reset()

    def test_emits_structured_json(self):
        out = _capture(lambda: create_logger("api", "info").info("ready", port=3000))
        self.assertEqual(out[-1]["level"], "info")
        self.assertEqual(out[-1]["service"], "api")
        self.assertEqual(out[-1]["msg"], "ready")
        self.assertEqual(out[-1]["port"], 3000)
        self.assertIn("hostname", out[-1])
        self.assertIn("pid", out[-1])
        self.assertIn("version", out[-1])
        self.assertIn("env", out[-1])
        self.assertIn("time", out[-1])

    def test_redacts_value_patterns(self):
        out = _capture(
            lambda: create_logger("api", "info").info(
                "seen", header="Bearer abcdefghijkl"
            )
        )
        self.assertEqual(out[-1]["header"], "Bearer ***")

    def test_serializes_exceptions(self):
        def go():
            try:
                raise ValueError("boom")
            except ValueError as exc:
                create_logger("api", "info").error("oops", err=exc)

        out = _capture(go)
        self.assertEqual(out[-1]["error"]["name"], "ValueError")
        self.assertEqual(out[-1]["error"]["message"], "boom")
        self.assertIn("stack", out[-1]["error"])

    def test_filters_below_level(self):
        def go():
            log = create_logger("sts", "warn")
            log.info("hidden")
            log.error("visible")

        out = _capture(go)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["msg"], "visible")

    def test_with_propagates_context(self):
        out = _capture(
            lambda: (
                create_logger("api", "info")
                .with_(request_id="r1", zone_id="z1")
                .info("ok")
            )
        )
        self.assertEqual(out[-1]["request_id"], "r1")
        self.assertEqual(out[-1]["zone_id"], "z1")

    def test_redacts_secret_fields(self):
        out = _capture(
            lambda: create_logger("api", "info").info(
                "login", user="alice", password="hunter2", api_key="k"
            )
        )
        self.assertEqual(out[-1]["user"], "alice")
        self.assertEqual(out[-1]["password"], REDACT_VALUE)
        self.assertEqual(out[-1]["api_key"], REDACT_VALUE)

    def test_with_redacts_bound_secrets(self):
        out = _capture(
            lambda: create_logger("api", "info").with_(access_token="t").info("ok")
        )
        self.assertEqual(out[-1]["access_token"], REDACT_VALUE)

    def test_redact_handles_nested(self):
        out = redact(
            {
                "ok": 1,
                "Authorization": "Bearer x",
                "nested": {"secret": "s", "keep": 2},
                "list": [{"token": "t"}, {"keep": "v"}],
            }
        )
        self.assertEqual(
            out,
            {
                "ok": 1,
                "Authorization": REDACT_VALUE,
                "nested": {"secret": REDACT_VALUE, "keep": 2},
                "list": [{"token": REDACT_VALUE}, {"keep": "v"}],
            },
        )

    def test_is_secret_key_substring_case_insensitive(self):
        self.assertTrue(is_secret_key("X-Auth-Token"))
        self.assertTrue(is_secret_key("user_password"))
        self.assertFalse(is_secret_key("zone_id"))

    def test_secret_keys_contains_password(self):
        self.assertIn("password", SECRET_KEYS)

    def test_trace_helpers_ignore_partial_and_malformed_headers(self):
        token = bind_trace(trace_id="trace-only")
        try:
            self.assertEqual(current_trace(), {"trace_id": "trace-only"})
        finally:
            reset_trace(token)
        token = bind_trace(span_id="span-only")
        try:
            self.assertEqual(current_trace(), {"span_id": "span-only"})
        finally:
            reset_trace(token)
        self.assertEqual(parse_traceparent("00-short-b7ad6b7169203331-01"), {})
        self.assertEqual(
            parse_traceparent("00-0af7651916cd43dd8448eb211c80319c-short-01"), {}
        )

    def test_hostname_failure_falls_back_to_unknown(self):
        with patch(
            "caracalai_core.logging.socket.gethostname", side_effect=OSError("dns")
        ):
            out = _capture(lambda: create_logger("api", "info").info("ready"))
        self.assertEqual(out[-1]["hostname"], "unknown")

    def test_queue_full_increments_drop_metric(self):
        import queue

        caracal_logging = importlib.import_module("caracalai_core.logging")

        class FullQueue:
            def put_nowait(self, _record):
                raise queue.Full()

        before = dropped_log_records()
        record = logging.LogRecord("caracal.test", logging.INFO, "", 0, "msg", (), None)
        with patch.object(caracal_logging, "_log_queue", FullQueue()):
            caracal_logging._NonBlockingQueueHandler().emit(record)
        self.assertEqual(dropped_log_records(), before + 1)

    def test_debug_sampling_and_default_env_level(self):
        import os

        caracal_logging = importlib.import_module("caracalai_core.logging")

        with patch.dict(os.environ, {"CARACAL_LOG_LEVEL": "debug"}, clear=False):
            with patch.object(caracal_logging, "_DEBUG_SAMPLE_N", 2):
                out = _capture(
                    lambda: [
                        create_logger("api").debug("skip"),
                        create_logger("api").debug("emit"),
                    ]
                )
        self.assertEqual([row["msg"] for row in out], ["emit"])
        self.assertGreaterEqual(caracal_logging.dev_log_metrics()["sampled"], 1)

    def test_shutdown_handler_runs_extra_and_exits_with_signal_code(self):
        import signal

        handlers = {}
        calls: list[str] = []

        with patch(
            "caracalai_core.logging.signal.signal",
            side_effect=lambda sig, handler: handlers.setdefault(sig, handler),
        ):
            install_shutdown_handler(lambda: calls.append("extra"))

        with self.assertRaises(SystemExit) as cm:
            handlers[signal.SIGTERM](signal.SIGTERM, None)

        self.assertEqual(calls, ["extra"])
        self.assertEqual(cm.exception.code, 128 + signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
