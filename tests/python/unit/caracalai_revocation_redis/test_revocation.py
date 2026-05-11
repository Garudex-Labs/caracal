# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis revocation connector tests for key lookup and stream consumption.

from __future__ import annotations

import hmac
import unittest
from hashlib import sha256
from typing import Any

from caracalai_revocation_redis import RedisRevocationConsumer, RedisRevocationStore
from caracalai_revocation_redis.revocation import REVOCATION_STREAM, STREAM_SIG_FIELD


class FakeRedis:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}
        self.acked: list[str] = []
        self.stream: list[Any] | None = None
        self.fail_get = False

    def get(self, key: str) -> str | None:
        if self.fail_get:
            raise RuntimeError("redis down")
        return self.values.get(key)

    def set(self, key: str, value: str, px: int) -> None:
        self.values[key] = value

    def xgroup_create(self, *_args: Any, **_kwargs: Any) -> None:
        return None

    def xreadgroup(self, *_args: Any, **_kwargs: Any) -> list[Any] | None:
        return self.stream

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


class RedisRevocationConsumerTests(unittest.TestCase):
    def test_marks_signed_stream_message_and_acks(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        key = bytes([7]) * 32
        values = {"zone_id": "zone1", "session_id": "sid-1", "reason": "grant_revoked"}
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
                            "reason": "grant_revoked",
                            STREAM_SIG_FIELD: sig,
                        },
                    )
                ],
            )
        ]

        consumer = RedisRevocationConsumer(redis, store, "resource-1", stream_hmac_key=key, require_signature=True)

        self.assertEqual(consumer.poll_once(), 1)
        self.assertTrue(store.is_revoked("sid-1"))
        self.assertEqual(redis.acked, ["1-0"])

    def test_acks_invalid_signature_without_marking_session(self) -> None:
        redis = FakeRedis()
        store = RedisRevocationStore(redis)
        redis.stream = [(REVOCATION_STREAM, [("1-1", {"session_id": "sid-2", STREAM_SIG_FIELD: "00"})])]

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


def sign_stream(key: bytes, stream: str, values: dict[str, str]) -> str:
    payload = stream + "\n"
    for name in sorted(values):
        payload += f"{name}={values[name]}\n"
    return hmac.new(key, payload.encode(), sha256).hexdigest()


if __name__ == "__main__":
    unittest.main()
