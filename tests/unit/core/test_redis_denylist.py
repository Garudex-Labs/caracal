"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for the Redis-backed session deny-list backend.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from caracal.core.session_manager import RedisSessionDenylistBackend


class _FakeRedisClient:
    def __init__(self) -> None:
        self._store: dict[str, str] = {}

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self._store[key] = value

    async def exists(self, key: str) -> int:
        return 1 if key in self._store else 0

    async def get(self, key: str) -> str | None:
        return self._store.get(key)


def _backend(redis_url: str = "redis://localhost:6379") -> RedisSessionDenylistBackend:
    return RedisSessionDenylistBackend(redis_url=redis_url)


def _inject_client(backend: RedisSessionDenylistBackend, client: _FakeRedisClient) -> None:
    backend._client = client


@pytest.mark.unit
class TestKeyHelpers:
    def test_key_format(self) -> None:
        b = _backend()
        assert b._key("abc") == "caracal:session_denylist:abc"

    def test_key_custom_prefix(self) -> None:
        b = RedisSessionDenylistBackend("redis://x", key_prefix="pfx:", token_prefix="deny:")
        assert b._key("tok") == "pfx:deny:tok"

    def test_principal_revoked_key(self) -> None:
        b = _backend()
        assert b._principal_revoked_after_key("pid-1") == "caracal:principal_session_revoked_after:pid-1"


@pytest.mark.unit
class TestAsUnixSeconds:
    def test_none_returns_none(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds(None) is None

    def test_datetime_with_tz(self) -> None:
        dt = datetime(2024, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
        result = RedisSessionDenylistBackend._as_unix_seconds(dt)
        assert result == int(dt.timestamp())

    def test_datetime_without_tz(self) -> None:
        dt = datetime(2024, 1, 1, 0, 0, 0)
        result = RedisSessionDenylistBackend._as_unix_seconds(dt)
        expected = int(dt.replace(tzinfo=timezone.utc).timestamp())
        assert result == expected

    def test_int_value(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds(1_700_000_000) == 1_700_000_000

    def test_float_value(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds(1_700_000_000.9) == 1_700_000_000

    def test_string_numeric(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds("1700000000") == 1_700_000_000

    def test_string_float_numeric(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds("1700000000.5") == 1_700_000_000

    def test_string_empty(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds("") is None

    def test_string_whitespace(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds("   ") is None

    def test_string_invalid(self) -> None:
        assert RedisSessionDenylistBackend._as_unix_seconds("not-a-number") is None


@pytest.mark.unit
@pytest.mark.asyncio
class TestAdd:
    async def test_add_stores_token(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        fut = datetime.now(timezone.utc) + timedelta(hours=1)
        await b.add("tok-1", fut)
        assert "caracal:session_denylist:tok-1" in client._store

    async def test_add_empty_jti_noop(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        fut = datetime.now(timezone.utc) + timedelta(hours=1)
        await b.add("", fut)
        assert not client._store

    async def test_add_whitespace_jti_noop(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        fut = datetime.now(timezone.utc) + timedelta(hours=1)
        await b.add("   ", fut)
        assert not client._store

    async def test_add_expired_noop(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        past = datetime.now(timezone.utc) - timedelta(seconds=60)
        await b.add("tok-expired", past)
        assert not client._store

    async def test_add_no_tz_expires_at(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        naive_fut = datetime.utcnow() + timedelta(hours=1)
        await b.add("tok-naive", naive_fut)
        assert "caracal:session_denylist:tok-naive" in client._store


@pytest.mark.unit
@pytest.mark.asyncio
class TestContains:
    async def test_contains_present(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        fut = datetime.now(timezone.utc) + timedelta(hours=1)
        await b.add("tok-x", fut)
        assert await b.contains("tok-x") is True

    async def test_contains_absent(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.contains("tok-missing") is False

    async def test_contains_empty_jti(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.contains("") is False

    async def test_contains_whitespace_jti(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.contains("   ") is False


@pytest.mark.unit
@pytest.mark.asyncio
class TestMarkPrincipalRevoked:
    async def test_mark_stores_timestamp(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("pid-1", revoked_at)
        key = "caracal:principal_session_revoked_after:pid-1"
        assert key in client._store
        assert int(client._store[key]) == int(revoked_at.timestamp())

    async def test_mark_empty_principal_noop(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("", revoked_at)
        assert not client._store

    async def test_mark_whitespace_principal_noop(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("  ", revoked_at)
        assert not client._store


@pytest.mark.unit
@pytest.mark.asyncio
class TestIsPrincipalRevoked:
    async def test_revoked_before_cutoff(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("pid-1", revoked_at)
        token_auth_time = datetime(2024, 6, 1, 11, 0, 0, tzinfo=timezone.utc)
        assert await b.is_principal_revoked("pid-1", token_auth_time) is True

    async def test_not_revoked_after_cutoff(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("pid-1", revoked_at)
        token_auth_time = datetime(2024, 6, 2, 0, 0, 0, tzinfo=timezone.utc)
        assert await b.is_principal_revoked("pid-1", token_auth_time) is False

    async def test_principal_not_in_store(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.is_principal_revoked("pid-unknown", 1_700_000_000) is False

    async def test_empty_principal_id_returns_false(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.is_principal_revoked("", 1_700_000_000) is False

    async def test_none_token_auth_time_returns_false(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        assert await b.is_principal_revoked("pid-1", None) is False

    async def test_auth_time_as_int(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("pid-1", revoked_at)
        before_ts = int(revoked_at.timestamp()) - 1
        assert await b.is_principal_revoked("pid-1", before_ts) is True

    async def test_auth_time_as_string(self) -> None:
        b = _backend()
        client = _FakeRedisClient()
        _inject_client(b, client)
        revoked_at = datetime(2024, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        await b.mark_principal_revoked("pid-1", revoked_at)
        before_str = str(int(revoked_at.timestamp()) - 1)
        assert await b.is_principal_revoked("pid-1", before_str) is True


@pytest.mark.unit
@pytest.mark.asyncio
class TestGetClient:
    async def test_client_created_lazily(self) -> None:
        b = _backend()
        fake_client = _FakeRedisClient()

        with patch("redis.asyncio.from_url", return_value=fake_client):
            client = await b._get_client()
            assert client is fake_client

    async def test_client_cached_on_second_call(self) -> None:
        b = _backend()
        fake_client = _FakeRedisClient()
        b._client = fake_client
        client = await b._get_client()
        assert client is fake_client
