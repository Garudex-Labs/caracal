# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis revocation connector tests for key lookup and stream consumption.

from __future__ import annotations

import hmac
import unittest
from hashlib import sha256

from caracalai_revocation_redis import RedisRevocationConsumer, RedisRevocationStore
from caracalai_revocation_redis.revocation import (
    DELEGATION_INVALIDATION_STREAM,
    FAIL_CLOSED_EPOCH,
    REVOCATION_STREAM,
    STREAM_SIG_FIELD,
    RedisClient,
    RedisDelegationInvalidationConsumer,
    RedisStreamClient,
    _normalize_autoclaim,
    _normalize_values,
    _to_text,
)
from redis.exceptions import ConnectionError as RedisConnectionError, ResponseError

StreamRows = list[tuple[str, list[tuple[str, dict[str, str]]]]]


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.set_calls: list[tuple[str, str, int]] = []
        self.acked: list[str] = []
        self.stream: StreamRows | None = None
        self.pending: list[tuple[str, dict[str, str]]] = []
        self.pending_pages: list[tuple[str, list[tuple[str, dict[str, str]]]]] = []
        self.group_error: Exception | None = None
        self.fail_get = False

    def get(self, key: str) -> str | None:
        if self.fail_get:
            raise RedisConnectionError("redis down")
        return self.values.get(key)

    def set(self, key: str, value: str, px: int) -> None:
        self.values[key] = value
        self.set_calls.append((key, value, px))

    def xgroup_create(self, *_args: object, **_kwargs: object) -> None:
        if self.group_error is not None:
            raise self.group_error
        return None

    def xreadgroup(self, *_args: object, **_kwargs: object) -> StreamRows | None:
        return self.stream

    def xautoclaim(
        self, *_args: object, **_kwargs: object
    ) -> tuple[str, list[tuple[str, dict[str, str]]]]:
        if self.pending_pages:
            return self.pending_pages.pop(0)
        pending = self.pending
        self.pending = []
        return ("0-0", pending)

    def xack(self, _stream: str, _group: str, message_id: str) -> None:
        self.acked.append(message_id)


class RedisRevocationStoreTests(unittest.TestCase):
    def test_checks_and_records_revoked_sessions(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)

        self.assertFalse(store.is_revoked("sid-1"))
        store.mark_revoked("sid-1")

        self.assertTrue(store.is_revoked("sid-1"))

    def test_fails_closed_by_default(self) -> None:
        redis = FakeRedis()
        redis.fail_get = True
        store = RedisRevocationStore(redis)

        self.assertTrue(store.is_revoked("sid-1"))

    def test_empty_sid_is_safe_and_custom_ttl_is_used(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis, key_prefix="rev:", default_ttl_ms=123)

        self.assertFalse(store.is_revoked(""))
        store.mark_revoked("")
        store.mark_revoked("sid-1", ttl_ms=456)

        self.assertEqual(redis.set_calls, [("rev:sid-1", "1", 456)])

    def test_fail_open_raises_redis_errors(self) -> None:
        redis = FakeRedis()
        redis.fail_get = True
        store = RedisRevocationStore(redis, fail_closed=False)

        with self.assertRaises(RedisConnectionError):
            store.is_revoked("sid-1")

    def test_tracks_the_latest_delegation_graph_epoch(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis, key_prefix="test:")

        self.assertEqual(store.current_delegation_epoch("zone1"), 0)
        store.mark_delegation_epoch("zone1", 7)
        store.mark_delegation_epoch("zone1", 6)

        self.assertEqual(store.current_delegation_epoch("zone1"), 7)
        self.assertEqual(redis.values["test:delegation-epoch:zone1"], "7")

    def test_normalizes_invalid_delegation_epochs_and_fail_modes(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis, key_prefix="test:")
        redis.values["test:delegation-epoch:zone1"] = "nan"

        self.assertEqual(store.current_delegation_epoch("zone1"), 0)

        redis.fail_get = True
        self.assertEqual(store.current_delegation_epoch("zone1"), FAIL_CLOSED_EPOCH)
        with self.assertRaises(RedisConnectionError):
            RedisRevocationStore(redis, fail_closed=False).current_delegation_epoch(
                "zone1"
            )

    def test_ignores_invalid_delegation_epoch_writes(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)

        store.mark_delegation_epoch("", 7)
        store.mark_delegation_epoch("zone1", -1)

        self.assertEqual(redis.set_calls, [])


class RedisRevocationConsumerTests(unittest.TestCase):
    def test_requires_hmac_key_when_signatures_are_mandatory(self) -> None:
        with self.assertRaisesRegex(ValueError, "stream_hmac_key is required"):
            RedisRevocationConsumer(
                FakeRedis(),
                RedisRevocationStore(FakeRedis()),
                "resource-1",
                require_signature=True,
            )

    def test_ensure_group_allows_existing_group_and_reraises_other_errors(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        consumer = RedisRevocationConsumer(redis, store, "resource-1")

        consumer.ensure_group()
        redis.group_error = ResponseError(
            "BUSYGROUP Consumer Group name already exists"
        )
        consumer.ensure_group()
        redis.group_error = ResponseError("NOGROUP missing stream")
        with self.assertRaises(ResponseError):
            consumer.ensure_group()

    def test_unsigned_messages_are_allowed_when_no_hmac_key_is_configured(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [(REVOCATION_STREAM, [("1-0", {"session_id": "sid-unsigned"})])]

        consumer = RedisRevocationConsumer(redis, store, "resource-1")

        self.assertEqual(consumer.poll_once(), 1)
        self.assertTrue(store.is_revoked("sid-unsigned"))
        self.assertEqual(redis.acked, ["1-0"])

    def test_missing_signature_is_acked_without_revocation_when_key_is_configured(
        self,
    ) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [(REVOCATION_STREAM, [("1-0", {"session_id": "sid-missing"})])]

        consumer = RedisRevocationConsumer(
            redis, store, "resource-1", stream_hmac_key=bytes([7]) * 32
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertFalse(store.is_revoked("sid-missing"))
        self.assertEqual(redis.acked, ["1-0"])

    def test_marks_signed_stream_message_authority_anchors_and_acks(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        key = bytes([7]) * 32
        values = {
            "zone_id": "zone1",
            "session_id": "sid-1",
            "root_sid": "root-1",
            "agent_session_id": "agent-1",
            "delegation_edge_id": "edge-1",
            "reason": "grant_revoked",
        }
        sig = sign_stream(key, REVOCATION_STREAM, values)
        redis.stream = [
            (
                REVOCATION_STREAM,
                [
                    (
                        "1-0",
                        {
                            "zone_id": "zone1",
                            "session_id": "sid-1",
                            "root_sid": "root-1",
                            "agent_session_id": "agent-1",
                            "delegation_edge_id": "edge-1",
                            "reason": "grant_revoked",
                            STREAM_SIG_FIELD: sig,
                        },
                    )
                ],
            )
        ]

        consumer = RedisRevocationConsumer(
            redis, store, "resource-1", stream_hmac_key=key, require_signature=True
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertTrue(store.is_revoked("sid-1"))
        self.assertTrue(store.is_revoked("root-1"))
        self.assertTrue(store.is_revoked("agent-1"))
        self.assertTrue(store.is_revoked("edge-1"))
        self.assertEqual(redis.acked, ["1-0"])

    def test_acks_invalid_signature_without_marking_session(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [
            (
                REVOCATION_STREAM,
                [("1-1", {"session_id": "sid-2", STREAM_SIG_FIELD: "00"})],
            )
        ]

        consumer = RedisRevocationConsumer(
            redis,
            store,
            "resource-1",
            stream_hmac_key=bytes([7]) * 32,
            require_signature=True,
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertFalse(store.is_revoked("sid-2"))
        self.assertEqual(redis.acked, ["1-1"])

    def test_replays_pending_messages_before_new_entries(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        key = bytes([7]) * 32
        values = {"zone_id": "zone1", "session_id": "sid-pending"}
        sig = sign_stream(key, REVOCATION_STREAM, values)
        redis.pending = [
            (
                "0-1",
                {
                    "zone_id": "zone1",
                    "session_id": "sid-pending",
                    STREAM_SIG_FIELD: sig,
                },
            )
        ]

        consumer = RedisRevocationConsumer(
            redis, store, "resource-1", stream_hmac_key=key, require_signature=True
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertTrue(store.is_revoked("sid-pending"))
        self.assertEqual(redis.acked, ["0-1"])

    def test_replays_multiple_pending_pages_and_sequence_values(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.pending_pages = [
            (
                "1-0",
                [(b"0-1", [b"session_id", b"sid-1", b"sid", b"sid-1", b"root_sid"])],
            ),
            ("0-0", [("0-2", ["session_id", "sid-2"])]),
        ]

        consumer = RedisRevocationConsumer(redis, store, "resource-1")

        self.assertEqual(consumer.poll_once(), 2)
        self.assertTrue(store.is_revoked("sid-1"))
        self.assertTrue(store.is_revoked("sid-2"))
        self.assertEqual(redis.acked, ["0-1", "0-2"])

    def test_normalizers_tolerate_malformed_stream_shapes(self) -> None:
        self.assertEqual(
            _normalize_values(["session_id", b"sid-1", "dangling"]),
            {"session_id": "sid-1", "dangling": ""},
        )
        self.assertEqual(_normalize_autoclaim(object()), ("0-0", []))
        self.assertEqual(_normalize_autoclaim(["1-0", "bad"]), ("1-0", []))
        self.assertEqual(_to_text(b"sid-1"), "sid-1")
        self.assertIsNone(RedisClient.get(object(), "key"))
        self.assertIsNone(RedisClient.set(object(), "key", "1", 1))
        self.assertIsNone(RedisStreamClient.xgroup_create(object()))
        self.assertIsNone(RedisStreamClient.xautoclaim(object()))
        self.assertIsNone(RedisStreamClient.xreadgroup(object()))
        self.assertIsNone(RedisStreamClient.xack(object(), "stream", "group", "1-0"))


class RedisDelegationInvalidationConsumerTests(unittest.TestCase):
    def test_marks_signed_delegation_graph_epochs(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        key = bytes([7]) * 32
        values = {
            "event": "edge_revoke",
            "zone_id": "zone1",
            "edge_id": "edge-1",
            "epoch": "9",
        }
        sig = sign_stream(key, DELEGATION_INVALIDATION_STREAM, values)
        redis.stream = [
            (
                DELEGATION_INVALIDATION_STREAM,
                [("1-0", {**values, STREAM_SIG_FIELD: sig})],
            )
        ]

        consumer = RedisDelegationInvalidationConsumer(
            redis, store, "resource-1", stream_hmac_key=key, require_signature=True
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertEqual(store.current_delegation_epoch("zone1"), 9)
        self.assertEqual(redis.acked, ["1-0"])

    def test_acks_invalid_signatures_without_marking_epochs(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [
            (
                DELEGATION_INVALIDATION_STREAM,
                [("1-1", {"zone_id": "zone1", "epoch": "11", STREAM_SIG_FIELD: "00"})],
            )
        ]

        consumer = RedisDelegationInvalidationConsumer(
            redis,
            store,
            "resource-1",
            stream_hmac_key=bytes([7]) * 32,
            require_signature=True,
        )

        self.assertEqual(consumer.poll_once(), 1)
        self.assertEqual(store.current_delegation_epoch("zone1"), 0)
        self.assertEqual(redis.acked, ["1-1"])

    def test_acks_malformed_epoch_messages_without_marking(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [
            (
                DELEGATION_INVALIDATION_STREAM,
                [
                    ("2-0", {"zone_id": "zone1", "epoch": "nan"}),
                    ("2-1", {"epoch": "3"}),
                ],
            )
        ]

        consumer = RedisDelegationInvalidationConsumer(redis, store, "resource-1")

        self.assertEqual(consumer.poll_once(), 2)
        self.assertEqual(store.current_delegation_epoch("zone1"), 0)
        self.assertEqual(redis.acked, ["2-0", "2-1"])


def sign_stream(key: bytes, stream: str, values: dict[str, str]) -> str:
    payload = stream + "\n"
    for name in sorted(values):
        payload += f"{name}={values[name]}\n"
    return hmac.new(key, payload.encode(), sha256).hexdigest()


if __name__ == "__main__":
    unittest.main()
