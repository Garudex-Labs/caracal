# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for trace context, cloud-secret redaction, field caps, and metrics snapshots.

from __future__ import annotations

from caracalai_core.audit import AuditClient, AuditEvent
from caracalai_core.logging import (
    bind_trace,
    current_trace,
    dev_log_metrics,
    parse_traceparent,
    redact_string,
    reset_trace,
    truncate_string,
)


def test_parse_traceparent_valid() -> None:
    tc = parse_traceparent("00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01")
    assert tc == {"trace_id": "0af7651916cd43dd8448eb211c80319c", "span_id": "b7ad6b7169203331"}


def test_parse_traceparent_invalid() -> None:
    assert parse_traceparent(None) == {}
    assert parse_traceparent("garbage") == {}


def test_trace_context_bind_and_reset() -> None:
    token = bind_trace(trace_id="t1", span_id="s1")
    try:
        assert current_trace() == {"trace_id": "t1", "span_id": "s1"}
    finally:
        reset_trace(token)
    assert current_trace() == {}


def test_redact_cloud_secrets() -> None:
    assert "***" in redact_string("AKIA1234567890ABCDEF")
    assert "***" in redact_string("ghp_1234567890abcdefghij1234567890abcdefgh")
    assert "***" in redact_string("xoxb-12345-67890-abcdefghijklmnop")
    pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END RSA PRIVATE KEY-----"
    assert "***" in redact_string(pem)


def test_truncate_string(monkeypatch) -> None:
    import caracalai_core.logging as L

    monkeypatch.setattr(L, "MAX_FIELD_BYTES", 16)
    out = L.truncate_string("x" * 64)
    assert out.endswith("[truncated]")


def test_dev_log_metrics_shape() -> None:
    m = dev_log_metrics()
    assert set(m.keys()) >= {"emitted", "dropped", "queue_depth", "queue_cap"}


class _FakeStreamer:
    def __init__(self) -> None:
        self.calls: list = []

    def xadd(self, stream: str, fields: dict) -> None:
        self.calls.append((stream, fields))


def test_audit_snapshot(tmp_path) -> None:
    s = _FakeStreamer()
    c = AuditClient(streamer=s, replay_dir=str(tmp_path), buffer_cap=4)
    for i in range(10):
        c.emit(AuditEvent(
            id=str(i),
            zone_id="z",
            event_type="t",
            request_id="r",
            decision="allow",
            evaluation_status="ok",
        ))
    snap = c.snapshot()
    assert snap["queue_cap"] == 4
    assert snap["emitted"] + snap["dropped"] == 10
