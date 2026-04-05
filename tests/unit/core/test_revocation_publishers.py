"""Unit tests for concrete revocation event publishers."""

from __future__ import annotations

import json

import pytest

from caracal.core.revocation_publishers import RedisPubSubRevocationEventPublisher


class _FakeRedis:
    def __init__(self) -> None:
        self.messages: list[tuple[str, str]] = []

    def publish(self, channel: str, message: str) -> int:
        self.messages.append((channel, message))
        return 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_redis_revocation_publisher_emits_json_payload_to_configured_channel() -> None:
    redis_client = _FakeRedis()
    publisher = RedisPubSubRevocationEventPublisher(
        redis_client,
        channel="caracal:revocation:test",
    )

    await publisher.publish_principal_revocation_event(
        event_type="principal_revoked",
        principal_id="principal-1",
        reason="policy_violation",
        actor_principal_id="admin-1",
        root_principal_id="principal-root",
        revoked_mandate_ids=["m-1", "m-2"],
        metadata={"source": "ttl"},
    )

    assert len(redis_client.messages) == 1
    channel, raw_payload = redis_client.messages[0]
    payload = json.loads(raw_payload)

    assert channel == "caracal:revocation:test"
    assert payload["event_type"] == "principal_revoked"
    assert payload["principal_id"] == "principal-1"
    assert payload["reason"] == "policy_violation"
    assert payload["actor_principal_id"] == "admin-1"
    assert payload["root_principal_id"] == "principal-root"
    assert payload["revoked_mandate_ids"] == ["m-1", "m-2"]
    assert payload["metadata"] == {"source": "ttl"}
    assert "published_at" in payload


@pytest.mark.unit
def test_redis_revocation_publisher_rejects_empty_channel() -> None:
    with pytest.raises(ValueError, match="channel cannot be empty"):
        RedisPubSubRevocationEventPublisher(_FakeRedis(), channel="")
