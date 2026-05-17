# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis-backed revocation store and stream consumer for resource servers.

from __future__ import annotations

import hmac
from collections.abc import Mapping, Sequence
from hashlib import sha256
from typing import Protocol

from redis.exceptions import RedisError, ResponseError

REVOCATION_STREAM = "caracal.sessions.revoke"
DEFAULT_REVOCATION_TTL_MS = 24 * 60 * 60 * 1000
STREAM_SIG_FIELD = "_sig"


class RedisClient(Protocol):
    def get(self, key: str) -> object | None:
        pass

    def set(self, key: str, value: str, px: int) -> object:
        pass


StreamValues = Mapping[object, object] | Sequence[object]
StreamMessage = tuple[object, StreamValues]
StreamBatch = list[tuple[object, list[StreamMessage]]]


class RedisStreamClient(RedisClient, Protocol):
    def xgroup_create(self, *args: object, **kwargs: object) -> object:
        pass

    def xautoclaim(self, *args: object, **kwargs: object) -> object:
        pass

    def xreadgroup(self, *args: object, **kwargs: object) -> StreamBatch | None:
        pass

    def xack(self, stream: str, group: str, message_id: str) -> object:
        pass


class RedisRevocationStore:
    def __init__(
        self,
        redis: RedisClient,
        key_prefix: str = "caracal:revoked:sessions:",
        default_ttl_ms: int = DEFAULT_REVOCATION_TTL_MS,
        fail_closed: bool = True,
    ) -> None:
        self._redis = redis
        self._key_prefix = key_prefix
        self._default_ttl_ms = default_ttl_ms
        self._fail_closed = fail_closed

    def is_revoked(self, sid: str) -> bool:
        if sid == "":
            return False
        try:
            return self._redis.get(self._key(sid)) is not None
        except RedisError:
            if self._fail_closed:
                return True
            raise

    def mark_revoked(self, sid: str, ttl_ms: int | None = None) -> None:
        if sid == "":
            return
        self._redis.set(self._key(sid), "1", px=ttl_ms or self._default_ttl_ms)

    def _key(self, sid: str) -> str:
        return f"{self._key_prefix}{sid}"


class RedisRevocationConsumer:
    def __init__(
        self,
        redis: RedisStreamClient,
        store: RedisRevocationStore,
        consumer: str,
        stream: str = REVOCATION_STREAM,
        group: str = "resource-revocation",
        batch_size: int = 50,
        block_ms: int = 0,
        pending_idle_ms: int = 30_000,
        stream_hmac_key: bytes | None = None,
        require_signature: bool | None = None,
    ) -> None:
        self._redis = redis
        self._store = store
        self._consumer = consumer
        self._stream = stream
        self._group = group
        self._batch_size = batch_size
        self._block_ms = block_ms
        self._pending_idle_ms = pending_idle_ms
        self._stream_hmac_key = stream_hmac_key
        self._require_signature = bool(stream_hmac_key) if require_signature is None else require_signature
        if self._require_signature and not self._stream_hmac_key:
            raise ValueError("stream_hmac_key is required when require_signature is true")

    def ensure_group(self) -> None:
        try:
            self._redis.xgroup_create(self._stream, self._group, id="0", mkstream=True)
        except ResponseError as err:
            if not str(err).startswith("BUSYGROUP"):
                raise

    def poll_once(self) -> int:
        handled = self._replay_pending()
        rows = self._redis.xreadgroup(
            self._group,
            self._consumer,
            {self._stream: ">"},
            count=self._batch_size,
            block=self._block_ms,
        )
        for _, messages in rows or []:
            for message_id, values in messages:
                self._process_message(_to_text(message_id), _normalize_values(values))
                handled += 1
        return handled

    def _replay_pending(self) -> int:
        handled = 0
        start = "0-0"
        while True:
            raw = self._redis.xautoclaim(
                self._stream,
                self._group,
                self._consumer,
                self._pending_idle_ms,
                start,
                count=self._batch_size,
            )
            next_id, messages = _normalize_autoclaim(raw)
            for message_id, values in messages:
                self._process_message(_to_text(message_id), _normalize_values(values))
                handled += 1
            if not messages or next_id in {"", "0-0"}:
                return handled
            start = next_id

    def _process_message(self, message_id: str, values: dict[str, str]) -> None:
        if not self._verify(values):
            self._redis.xack(self._stream, self._group, message_id)
            return
        sid = values.get("session_id", "")
        if sid:
            self._store.mark_revoked(sid)
        self._redis.xack(self._stream, self._group, message_id)

    def _verify(self, values: Mapping[str, str]) -> bool:
        if not self._require_signature and not self._stream_hmac_key:
            return True
        sig = values.get(STREAM_SIG_FIELD)
        if not sig or not self._stream_hmac_key:
            return False
        want = _sign_stream(self._stream_hmac_key, self._stream, values)
        return hmac.compare_digest(sig, want)


def _normalize_values(values: StreamValues) -> dict[str, str]:
    if isinstance(values, Mapping):
        return {_to_text(k): _to_text(v) for k, v in values.items()}
    out: dict[str, str] = {}
    for i in range(0, len(values), 2):
        out[_to_text(values[i])] = _to_text(values[i + 1]) if i + 1 < len(values) else ""
    return out


def _normalize_autoclaim(raw: object) -> tuple[str, list[StreamMessage]]:
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)) or len(raw) < 2:
        return "0-0", []
    next_id = _to_text(raw[0])
    messages = raw[1]
    if not isinstance(messages, Sequence) or isinstance(messages, (str, bytes)):
        return next_id, []
    out: list[StreamMessage] = []
    for item in messages:
        if isinstance(item, Sequence) and not isinstance(item, (str, bytes)) and len(item) >= 2:
            out.append((item[0], item[1]))
    return next_id, out


def _to_text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode()
    return str(value)


def _sign_stream(key: bytes, stream: str, values: Mapping[str, str]) -> str:
    payload = stream + "\n"
    for name in sorted(k for k in values if k != STREAM_SIG_FIELD):
        payload += f"{name}={values[name]}\n"
    return hmac.new(key, payload.encode(), sha256).hexdigest()
