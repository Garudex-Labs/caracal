# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Tests for caracalai_core.audit client signing, persistence, drops, and replay.

import shutil
import tempfile
import time
import unittest
from pathlib import Path

from caracalai_core.audit import (
    AuditClient,
    AuditEvent,
    create_event_id,
    default_replay_dir,
)
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


def _event(id_: str = "ev-1") -> AuditEvent:
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


class AuditClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="caracal-audit-"))
        self.replay_dir = self.tmp / "replay"
        self.replay_dir.mkdir()
        self.logger = create_logger("audit-test", "fatal")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_requires_hmac_in_production(self):
        with self.assertRaisesRegex(ValueError, "audit_hmac_key is required"):
            AuditClient(
                streamer=FakeStreamer(),
                replay_dir=self.replay_dir,
                logger=self.logger,
                production=True,
            )

    def test_requires_streamer(self):
        with self.assertRaisesRegex(ValueError, "streamer is required"):
            AuditClient(streamer=None, replay_dir=self.replay_dir, logger=self.logger)  # type: ignore[arg-type]

    def test_rejects_short_audit_hmac_key(self):
        with self.assertRaisesRegex(ValueError, "at least 32 bytes"):
            AuditClient(
                streamer=FakeStreamer(),
                replay_dir=self.replay_dir,
                logger=self.logger,
                audit_hmac_key=b"short",
            )

    def test_signs_events_when_key_present(self):
        s = FakeStreamer()
        c = AuditClient(
            streamer=s,
            replay_dir=self.replay_dir,
            logger=self.logger,
            audit_hmac_key=b"k" * 32,
            flush_ttl_ms=10,
        )
        c.start()
        c.emit(_event())
        time.sleep(0.05)
        c.close()
        self.assertEqual(len(s.calls), 1)
        fields = s.calls[0][1]
        self.assertIn("sig", fields)
        self.assertEqual(len(fields["sig"]), 64)

    def test_persists_on_sink_failure(self):
        s = FakeStreamer()
        s.fail_next = 100
        c = AuditClient(
            streamer=s, replay_dir=self.replay_dir, logger=self.logger, flush_ttl_ms=10
        )
        c.start()
        c.emit(_event())
        time.sleep(0.05)
        c.close()
        self.assertTrue(list(self.replay_dir.glob("*.ndjson")))

    def test_drops_on_overflow(self):
        s = FakeStreamer()
        s.fail_next = 1_000_000
        c = AuditClient(
            streamer=s,
            replay_dir=self.replay_dir,
            logger=self.logger,
            buffer_cap=2,
            flush_batch=1_000_000,
            flush_ttl_ms=1_000_000,
        )
        c.start()
        for _ in range(10):
            c.emit(_event())
        self.assertGreater(c.dropped(), 0)
        c.close()

    def test_drop_callback_and_closed_emit_are_deterministic(self):
        drops: list[int] = []
        c = AuditClient(
            streamer=FakeStreamer(),
            replay_dir=self.replay_dir,
            logger=self.logger,
            buffer_cap=1,
            flush_batch=100,
            flush_ttl_ms=1_000_000,
            on_dropped=drops.append,
        )
        c.emit(_event("ev-1"))
        c.emit(_event("ev-2"))
        self.assertEqual(drops, [1])
        c.close()
        c.close()
        c.emit(_event("ev-3"))
        self.assertEqual(c.snapshot()["queue_depth"], 0)

    def test_sink_and_replay_callbacks_track_batches(self):
        sink_errors: list[int] = []
        persisted: list[int] = []
        drained: list[int] = []
        s = FakeStreamer()
        s.fail_next = 1
        c = AuditClient(
            streamer=s,
            replay_dir=self.replay_dir,
            logger=self.logger,
            flush_batch=10,
            on_sink_error=lambda: sink_errors.append(1),
            on_replay_persisted=persisted.append,
            on_replay_drained=drained.append,
        )
        c.emit(_event("ev-1"))
        c._flush_once()
        self.assertEqual(sink_errors, [1])
        self.assertEqual(persisted, [1])
        self.assertEqual(c.snapshot()["sink_errors"], 1)

        c.replay_pending()
        self.assertEqual(drained, [1])
        self.assertEqual(c.snapshot()["drained"], 1)

    def test_empty_persist_and_missing_replay_dir_are_noops(self):
        c = AuditClient(
            streamer=FakeStreamer(),
            replay_dir=self.replay_dir / "missing",
            logger=self.logger,
        )
        c._persist_batch([])
        c.replay_pending()
        self.assertEqual(c.snapshot()["persisted"], 0)

    def test_bad_replay_file_is_retained_for_retry(self):
        path = self.replay_dir / "pending-bad.ndjson"
        path.write_text("{not-json}\n", encoding="utf-8")
        c = AuditClient(
            streamer=FakeStreamer(), replay_dir=self.replay_dir, logger=self.logger
        )
        c.replay_pending()
        self.assertTrue(path.exists())

    def test_replays_persisted_on_start(self):
        s1 = FakeStreamer()
        s1.fail_next = 100
        c1 = AuditClient(
            streamer=s1, replay_dir=self.replay_dir, logger=self.logger, flush_ttl_ms=10
        )
        c1.start()
        c1.emit(_event())
        time.sleep(0.05)
        c1.close()
        self.assertEqual(len(list(self.replay_dir.glob("*.ndjson"))), 1)

        s2 = FakeStreamer()
        c2 = AuditClient(
            streamer=s2, replay_dir=self.replay_dir, logger=self.logger, flush_ttl_ms=10
        )
        c2.start()
        c2.close()
        self.assertEqual(len(s2.calls), 1)
        self.assertEqual(list(self.replay_dir.glob("*.ndjson")), [])

    def test_default_replay_dir_and_event_ids_are_stable_shapes(self):
        path = default_replay_dir("audit")
        self.assertIn("caracal-audit-replay", path)
        self.assertEqual(Path(path).name, "audit")
        self.assertRegex(create_event_id(), r"^[0-9a-f-]{36}$")


if __name__ == "__main__":
    unittest.main()
