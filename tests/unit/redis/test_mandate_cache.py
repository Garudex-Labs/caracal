"""Unit tests for Redis mandate cache serialization behavior."""

import json
from datetime import datetime, timedelta
from unittest.mock import MagicMock, Mock
from uuid import uuid4

import pytest

from caracal.db.models import ExecutionMandate
from caracal.redis.client import RedisClient
from caracal.redis.mandate_cache import RedisMandateCache


@pytest.fixture
def mock_redis_client():
    """Provide a minimal in-memory Redis client stub."""
    client = Mock(spec=RedisClient)
    client._client = MagicMock()
    client._client.scan = MagicMock(return_value=(0, []))

    storage = {}

    def _set(key, value, ex=None):
        del ex
        storage[key] = value
        return True

    def _get(key):
        return storage.get(key)

    def _delete(*keys):
        deleted = 0
        for key in keys:
            if key in storage:
                del storage[key]
                deleted += 1
        return deleted

    def _incr(key):
        current = int(storage.get(key, "0"))
        storage[key] = str(current + 1)
        return current + 1

    client.set = _set
    client.get = _get
    client.delete = _delete
    client.incr = _incr
    return client


@pytest.mark.unit
def test_cache_round_trip_uses_mandate_metadata_field(mock_redis_client):
    cache = RedisMandateCache(mock_redis_client)
    now = datetime.utcnow()

    mandate = ExecutionMandate(
        mandate_id=uuid4(),
        issuer_id=uuid4(),
        subject_id=uuid4(),
        valid_from=now,
        valid_until=now + timedelta(minutes=10),
        resource_scope=["provider/test"],
        action_scope=["read"],
        signature="sig",
        created_at=now,
        mandate_metadata={"source": "unit"},
        revoked=False,
        delegation_type="peer",
        context_tags=["tenant:test"],
        network_distance=1,
    )

    cache.cache_mandate(mandate)
    cached = cache.get_cached_mandate(mandate.mandate_id)

    assert cached is not None
    assert cached["mandate_metadata"] == {"source": "unit"}
    assert "metadata" not in cached
    assert cached["delegation_type"] == "peer"
    assert cached["context_tags"] == ["tenant:test"]

    reconstructed = ExecutionMandate(**cached)
    assert reconstructed.mandate_metadata == {"source": "unit"}
    assert reconstructed.delegation_type == "peer"
    assert reconstructed.context_tags == ["tenant:test"]
