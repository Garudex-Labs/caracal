"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for RedisClient wrapping behavior and error handling.
"""
import pytest
from unittest.mock import MagicMock, patch, call

import redis as redis_module


def _make_client(**kwargs):
    """Build a RedisClient with mocked underlying Redis connection."""
    from caracal.redis.client import RedisClient
    with (
        patch("caracal.redis.client.redis.ConnectionPool"),
        patch("caracal.redis.client.redis.Redis"),
    ):
        client = RedisClient(**kwargs)
    client._client = MagicMock()
    return client


@pytest.mark.unit
class TestRedisClientInit:
    def test_stores_basic_attrs(self):
        c = _make_client(host="myhost", port=6380, db=1)
        assert c.host == "myhost"
        assert c.port == 6380
        assert c.db == 1

    def test_defaults(self):
        c = _make_client()
        assert c.host == "localhost"
        assert c.port == 6379
        assert c.ssl is False


@pytest.mark.unit
class TestRedisClientPing:
    def test_ping_success(self):
        c = _make_client()
        c._client.ping.return_value = True
        assert c.ping() is True

    def test_ping_failure_returns_false(self):
        c = _make_client()
        c._client.ping.side_effect = redis_module.RedisError("conn refused")
        assert c.ping() is False


@pytest.mark.unit
class TestRedisClientGet:
    def test_get_existing_key(self):
        c = _make_client()
        c._client.get.return_value = "value"
        assert c.get("k") == "value"

    def test_get_missing_key_returns_none(self):
        c = _make_client()
        c._client.get.return_value = None
        assert c.get("k") is None

    def test_get_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.get.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.get("k")


@pytest.mark.unit
class TestRedisClientSet:
    def test_set_basic(self):
        c = _make_client()
        c._client.set.return_value = True
        assert c.set("k", "v") is True
        c._client.set.assert_called_once_with("k", "v", ex=None, px=None, nx=False, xx=False)

    def test_set_with_expiry(self):
        c = _make_client()
        c._client.set.return_value = True
        c.set("k", "v", ex=60)
        c._client.set.assert_called_once_with("k", "v", ex=60, px=None, nx=False, xx=False)

    def test_set_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.set.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.set("k", "v")


@pytest.mark.unit
class TestRedisClientDelete:
    def test_delete_returns_count(self):
        c = _make_client()
        c._client.delete.return_value = 2
        assert c.delete("a", "b") == 2

    def test_delete_raises_on_error(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.delete.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.delete("k")


@pytest.mark.unit
class TestRedisClientExists:
    def test_exists_returns_count(self):
        c = _make_client()
        c._client.exists.return_value = 1
        assert c.exists("k") == 1

    def test_exists_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.exists.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.exists("k")


@pytest.mark.unit
class TestRedisClientExpire:
    def test_expire_success(self):
        c = _make_client()
        c._client.expire.return_value = True
        assert c.expire("k", 60) is True

    def test_expire_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.expire.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.expire("k", 60)


@pytest.mark.unit
class TestRedisClientTtl:
    def test_ttl_returns_value(self):
        c = _make_client()
        c._client.ttl.return_value = 120
        assert c.ttl("k") == 120

    def test_ttl_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.ttl.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.ttl("k")


@pytest.mark.unit
class TestRedisClientIncr:
    def test_incr_default_amount(self):
        c = _make_client()
        c._client.incr.return_value = 1
        assert c.incr("k") == 1

    def test_incr_custom_amount(self):
        c = _make_client()
        c._client.incr.return_value = 5
        result = c.incr("k", amount=5)
        assert result == 5

    def test_incr_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.incr.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.incr("k")


@pytest.mark.unit
class TestRedisClientHashes:
    def test_hget_returns_value(self):
        c = _make_client()
        c._client.hget.return_value = "val"
        assert c.hget("h", "f") == "val"

    def test_hget_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.hget.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.hget("h", "f")

    def test_hset_returns_count(self):
        c = _make_client()
        c._client.hset.return_value = 1
        assert c.hset("h", "f", "v") == 1

    def test_hgetall_returns_dict(self):
        c = _make_client()
        c._client.hgetall.return_value = {"f": "v"}
        assert c.hgetall("h") == {"f": "v"}

    def test_hgetall_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.hgetall.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.hgetall("h")


@pytest.mark.unit
class TestRedisClientGetdel:
    def test_getdel_native_command(self):
        c = _make_client()
        c._client.execute_command.return_value = "v"
        assert c.getdel("k") == "v"

    def test_getdel_unknown_command_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.execute_command.side_effect = redis_module.ResponseError("unknown command")
        with pytest.raises(RedisConnectionError):
            c.getdel("k")
        c._client.eval.assert_not_called()

    def test_getdel_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.execute_command.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.getdel("k")


@pytest.mark.unit
class TestRedisClientPublish:
    def test_publish_returns_count(self):
        c = _make_client()
        c._client.publish.return_value = 3
        assert c.publish("chan", "msg") == 3

    def test_publish_redis_error_raises(self):
        from caracal.redis.client import RedisConnectionError
        c = _make_client()
        c._client.publish.side_effect = redis_module.RedisError("fail")
        with pytest.raises(RedisConnectionError):
            c.publish("chan", "msg")


@pytest.mark.unit
class TestRedisClientClose:
    def test_close_disconnects_pool(self):
        c = _make_client()
        pool_mock = MagicMock()
        c._pool = pool_mock
        c.close()
        pool_mock.disconnect.assert_called_once()
