"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for MerkleBatcher dataclass and pure methods.
"""
import asyncio
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

from caracal.merkle.batcher import MerkleBatch, MerkleBatcher


def _signer():
    s = MagicMock()
    s.sign_root = AsyncMock(return_value=None)
    return s


@pytest.mark.unit
class TestMerkleBatch:
    def test_dataclass_fields(self):
        from uuid import uuid4
        batch = MerkleBatch(
            batch_id=uuid4(),
            event_ids=[1, 2, 3],
            event_count=3,
            merkle_root=b"\x00" * 32,
            created_at=datetime.utcnow(),
        )
        assert batch.event_count == 3
        assert len(batch.event_ids) == 3
        assert len(batch.merkle_root) == 32


@pytest.mark.unit
class TestMerkleBatcherInit:
    def test_valid_init(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=100, batch_timeout_seconds=60)
        assert b.batch_size_limit == 100
        assert b.batch_timeout_seconds == 60

    def test_negative_batch_size_raises(self):
        with pytest.raises(ValueError):
            MerkleBatcher(merkle_signer=_signer(), batch_size_limit=0)

    def test_negative_timeout_raises(self):
        with pytest.raises(ValueError):
            MerkleBatcher(merkle_signer=_signer(), batch_timeout_seconds=0)

    def test_batch_size_one_valid(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=1)
        assert b.batch_size_limit == 1


@pytest.mark.unit
class TestMerkleBatcherState:
    def test_initial_batch_size_zero(self):
        b = MerkleBatcher(merkle_signer=_signer())
        assert b.get_current_batch_size() == 0

    def test_initial_batch_age_none(self):
        b = MerkleBatcher(merkle_signer=_signer())
        assert b.get_batch_age() is None


@pytest.mark.asyncio
@pytest.mark.unit
class TestMerkleBatcherAddEvent:
    async def test_add_event_increments_size(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=10)
        await b.add_event(1, b"\x00" * 32)
        assert b.get_current_batch_size() == 1

    async def test_invalid_negative_event_id_raises(self):
        b = MerkleBatcher(merkle_signer=_signer())
        with pytest.raises(ValueError):
            await b.add_event(-1, b"\x00" * 32)

    async def test_invalid_hash_length_raises(self):
        b = MerkleBatcher(merkle_signer=_signer())
        with pytest.raises(ValueError):
            await b.add_event(1, b"\x00" * 16)

    async def test_empty_hash_raises(self):
        b = MerkleBatcher(merkle_signer=_signer())
        with pytest.raises(ValueError):
            await b.add_event(1, b"")

    async def test_batch_closes_when_size_limit_reached(self):
        signer = _signer()
        b = MerkleBatcher(merkle_signer=signer, batch_size_limit=2)
        await b.add_event(1, b"\x01" * 32)
        result = await b.add_event(2, b"\x02" * 32)
        assert result is not None
        assert isinstance(result.batch_id, UUID)
        assert result.event_count == 2
        assert b.get_current_batch_size() == 0

    async def test_batch_does_not_close_before_limit(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=10)
        result = await b.add_event(1, b"\x01" * 32)
        assert result is None
        assert b.get_current_batch_size() == 1

    async def test_batch_age_set_after_first_event(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=10)
        await b.add_event(1, b"\x01" * 32)
        age = b.get_batch_age()
        assert age is not None


@pytest.mark.asyncio
@pytest.mark.unit
class TestMerkleBatcherCloseBatch:
    async def test_close_empty_batch_returns_none(self):
        b = MerkleBatcher(merkle_signer=_signer())
        result = await b.close_batch()
        assert result is None

    async def test_close_with_events_returns_batch(self):
        signer = _signer()
        b = MerkleBatcher(merkle_signer=signer, batch_size_limit=10)
        await b.add_event(1, b"\x01" * 32)
        await b.add_event(2, b"\x02" * 32)
        result = await b.close_batch()
        assert result is not None
        assert result.event_count == 2

    async def test_after_close_batch_size_is_zero(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=10)
        await b.add_event(1, b"\x01" * 32)
        await b.close_batch()
        assert b.get_current_batch_size() == 0

    async def test_after_close_batch_age_is_none(self):
        b = MerkleBatcher(merkle_signer=_signer(), batch_size_limit=10)
        await b.add_event(1, b"\x01" * 32)
        await b.close_batch()
        assert b.get_batch_age() is None
