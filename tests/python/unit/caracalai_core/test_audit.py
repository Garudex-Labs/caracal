# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for caracalai_core.audit client signing, persistence, drops, and replay.

import json
import time
from pathlib import Path

import pytest

from caracalai_core.audit import AuditClient, AuditEvent
from caracalai_core.logging import create_logger


class FakeStreamer:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []
        self.fail_next = 0

    def xadd(self, stream, fields):
        if self.fail_next > 0:
            self.fail_next -= 1
            raise RuntimeError("redis down")
        self.calls.append((stream, dict(fields)))
        return "1-0"


def _event(id_="ev-1") -> AuditEvent:
    return AuditEvent(
        id=id_,
        zone_id="z1",
        event_type="authorization_decision",
        request_id="r1",
        decision="allow",
        evaluation_status="success",
        determining_policies_json=[],
        diagnostics_json={},
        occurred_at="2026-01-01T00:00:00Z",
    )


@pytest.fixture
def replay_dir(tmp_path: Path) -> Path:
    d = tmp_path / "replay"
    d.mkdir()
    return d


@pytest.fixture
def logger():
    return create_logger("audit-test", "fatal")


def test_requires_hmac_in_production(replay_dir, logger):
    with pytest.raises(ValueError, match="hmac_key is required"):
        AuditClient(streamer=FakeStreamer(), replay_dir=replay_dir, logger=logger, production=True)


def test_rejects_short_hmac_key(replay_dir, logger):
    with pytest.raises(ValueError, match="at least 32 bytes"):
        AuditClient(streamer=FakeStreamer(), replay_dir=replay_dir, logger=logger, hmac_key=b"short")


def test_signs_events_when_key_present(replay_dir, logger):
    s = FakeStreamer()
    c = AuditClient(streamer=s, replay_dir=replay_dir, logger=logger, hmac_key=b"k" * 32, flush_ttl_ms=10)
    c.start()
    c.emit(_event())
    time.sleep(0.05)
    c.close()
    assert len(s.calls) == 1
    fields = s.calls[0][1]
    assert "sig" in fields and len(fields["sig"]) == 64


def test_persists_on_sink_failure(replay_dir, logger):
    s = FakeStreamer()
    s.fail_next = 100
    c = AuditClient(streamer=s, replay_dir=replay_dir, logger=logger, flush_ttl_ms=10)
    c.start()
    c.emit(_event())
    time.sleep(0.05)
    c.close()
    files = list(replay_dir.glob("*.ndjson"))
    assert files, "expected at least one persisted file"


def test_drops_on_overflow(replay_dir, logger):
    s = FakeStreamer()
    s.fail_next = 1_000_000
    c = AuditClient(
        streamer=s, replay_dir=replay_dir, logger=logger,
        buffer_cap=2, flush_batch=1_000_000, flush_ttl_ms=1_000_000,
    )
    c.start()
    for _ in range(10):
        c.emit(_event())
    assert c.dropped() > 0
    c.close()


def test_replays_persisted_on_start(replay_dir, logger):
    s1 = FakeStreamer()
    s1.fail_next = 100
    c1 = AuditClient(streamer=s1, replay_dir=replay_dir, logger=logger, flush_ttl_ms=10)
    c1.start()
    c1.emit(_event())
    time.sleep(0.05)
    c1.close()
    persisted = list(replay_dir.glob("*.ndjson"))
    assert len(persisted) == 1

    s2 = FakeStreamer()
    c2 = AuditClient(streamer=s2, replay_dir=replay_dir, logger=logger, flush_ttl_ms=10)
    c2.start()
    c2.close()
    assert len(s2.calls) == 1
    assert not list(replay_dir.glob("*.ndjson"))
