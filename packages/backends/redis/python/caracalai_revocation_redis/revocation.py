# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Redis-backed revocation store and stream consumer for resource servers.

from __future__ import annotations

import hmac
import json
from collections.abc import Mapping, Sequence
from hashlib import sha256
from typing import Protocol

from redis.exceptions import RedisError, ResponseError

REVOCATION_STREAM = "caracal.sessions.revoke"
DELEGATION_INVALIDATION_STREAM = "caracal.delegations.invalidate"
DEFAULT_REVOCATION_TTL_MS = 24 * 60 * 60 * 1000
DEFAULT_DEAD_LETTER_MAX_LENGTH = 10_000
FAIL_CLOSED_EPOCH = 2**63 - 1
STREAM_SIG_FIELD = "_sig"
MAX_EPOCH_SCRIPT = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0') or 0
local candidate = tonumber(ARGV[1])
if candidate > current then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return 1
end
return 0
"""


class RedisClient(Protocol):
    def get(self, key: str) -> object | None:
        pass

    def set(self, key: str, value: str, px: int) -> object:
        pass

    def eval(self, script: str, numkeys: int, *keys_and_args: object) -> object:
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

    def xadd(
        self,
        name: str,
        fields: Mapping[str, str],
        maxlen: int,
        approximate: bool,
    ) -> object:
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

    def is_revoked(self, anchor_id: str) -> bool:
        if anchor_id == "":
            return False
        try:
            return self._redis.get(self._key(anchor_id)) is not None
        except RedisError:
            if self._fail_closed:
                return True
            raise

    def mark_revoked(self, anchor_id: str, ttl_ms: int | None = None) -> None:
        if anchor_id == "":
            return
        self._redis.set(self._key(anchor_id), "1", px=ttl_ms or self._default_ttl_ms)

    def current_delegation_epoch(self, zone_id: str) -> int:
        try:
            value = self._redis.get(self._delegation_epoch_key(zone_id))
        except RedisError:
            if self._fail_closed:
                return FAIL_CLOSED_EPOCH
            raise
        try:
            epoch = int(_to_text(value)) if value is not None else 0
        except ValueError:
            return 0
        return epoch if epoch > 0 else 0

    def mark_delegation_epoch(
        self, zone_id: str, epoch: int, ttl_ms: int | None = None
    ) -> None:
        if zone_id == "" or epoch < 0:
            return
        self._redis.eval(
            MAX_EPOCH_SCRIPT,
            1,
            self._delegation_epoch_key(zone_id),
            str(epoch),
            str(ttl_ms or self._default_ttl_ms),
        )

    def _key(self, anchor_id: str) -> str:
        return f"{self._key_prefix}{anchor_id}"

    def _delegation_epoch_key(self, zone_id: str) -> str:
        return f"{self._key_prefix}delegation-epoch:{zone_id}"


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
        dead_letter_max_length: int = DEFAULT_DEAD_LETTER_MAX_LENGTH,
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
        self._require_signature = (
            bool(stream_hmac_key) if require_signature is None else require_signature
        )
        self._dead_letter_max_length = dead_letter_max_length
        if self._require_signature and not self._stream_hmac_key:
            raise ValueError(
                "stream_hmac_key is required when require_signature is true"
            )

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
            self._dead_letter(message_id, values, "invalid_signature")
            self._redis.xack(self._stream, self._group, message_id)
            return
        anchors = _revocation_anchors(values)
        if not anchors:
            self._dead_letter(message_id, values, "missing_revocation_anchor")
            self._redis.xack(self._stream, self._group, message_id)
            return
        for anchor in anchors:
            self._store.mark_revoked(anchor)
        self._redis.xack(self._stream, self._group, message_id)

    def _verify(self, values: Mapping[str, str]) -> bool:
        if not self._require_signature and not self._stream_hmac_key:
            return True
        sig = values.get(STREAM_SIG_FIELD)
        if not sig or not self._stream_hmac_key:
            return False
        want = _sign_stream(self._stream_hmac_key, self._stream, values)
        return hmac.compare_digest(sig, want)

    def _dead_letter(
        self, message_id: str, values: Mapping[str, str], reason: str
    ) -> None:
        self._redis.xadd(
            f"{self._stream}.dead",
            {
                "source_id": message_id,
                "reason": reason,
                "payload": json.dumps(values, separators=(",", ":"), sort_keys=True),
            },
            maxlen=self._dead_letter_max_length,
            approximate=True,
        )


class RedisDelegationInvalidationConsumer(RedisRevocationConsumer):
    def __init__(
        self,
        redis: RedisStreamClient,
        store: RedisRevocationStore,
        consumer: str,
        stream: str = DELEGATION_INVALIDATION_STREAM,
        group: str = "resource-delegation-invalidation",
        batch_size: int = 50,
        block_ms: int = 0,
        pending_idle_ms: int = 30_000,
        stream_hmac_key: bytes | None = None,
        require_signature: bool | None = None,
        dead_letter_max_length: int = DEFAULT_DEAD_LETTER_MAX_LENGTH,
    ) -> None:
        super().__init__(
            redis,
            store,
            consumer,
            stream=stream,
            group=group,
            batch_size=batch_size,
            block_ms=block_ms,
            pending_idle_ms=pending_idle_ms,
            stream_hmac_key=stream_hmac_key,
            require_signature=require_signature,
            dead_letter_max_length=dead_letter_max_length,
        )

    def _process_message(self, message_id: str, values: dict[str, str]) -> None:
        if not self._verify(values):
            self._dead_letter(message_id, values, "invalid_signature")
            self._redis.xack(self._stream, self._group, message_id)
            return
        zone_id = values.get("zone_id", "")
        try:
            epoch = int(values.get("epoch", ""))
        except ValueError:
            epoch = -1
        if zone_id and epoch >= 0:
            self._store.mark_delegation_epoch(zone_id, epoch)
        else:
            self._dead_letter(message_id, values, "invalid_delegation_epoch")
        self._redis.xack(self._stream, self._group, message_id)


def _normalize_values(values: StreamValues) -> dict[str, str]:
    if isinstance(values, Mapping):
        return {_to_text(k): _to_text(v) for k, v in values.items()}
    out: dict[str, str] = {}
    for i in range(0, len(values), 2):
        out[_to_text(values[i])] = (
            _to_text(values[i + 1]) if i + 1 < len(values) else ""
        )
    return out


def _revocation_anchors(values: Mapping[str, str]) -> list[str]:
    anchors = [
        values.get("session_id", ""),
        values.get("sid", ""),
        values.get("root_sid", ""),
        values.get("agent_session_id", ""),
        values.get("delegation_edge_id", ""),
    ]
    out: list[str] = []
    for anchor in anchors:
        if anchor and anchor not in out:
            out.append(anchor)
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
        if (
            isinstance(item, Sequence)
            and not isinstance(item, (str, bytes))
            and len(item) >= 2
        ):
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
