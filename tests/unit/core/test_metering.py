"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for the metering collector module.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock, Mock
from uuid import uuid4

import pytest

from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.exceptions import InvalidMeteringEventError, MeteringCollectionError


def _make_event(**kwargs):
    defaults = {
        "principal_id": "pid-1",
        "resource_type": "mcp.tool.search",
        "quantity": Decimal("1.0"),
    }
    defaults.update(kwargs)
    return MeteringEvent(**defaults)


def _ledger_stub():
    stub = Mock()
    ev = Mock()
    ev.event_id = str(uuid4())
    stub.append_event.return_value = ev
    return stub


@pytest.mark.unit
class TestMeteringEvent:
    def test_creates_with_minimal_fields(self):
        ev = _make_event()
        assert ev.principal_id == "pid-1"
        assert ev.resource_type == "mcp.tool.search"
        assert ev.quantity == Decimal("1.0")
        assert ev.timestamp is not None

    def test_auto_timestamp(self):
        ev = _make_event()
        assert isinstance(ev.timestamp, datetime)

    def test_custom_timestamp(self):
        ts = datetime(2026, 1, 1, 0, 0, 0)
        ev = _make_event(timestamp=ts)
        assert ev.timestamp == ts

    def test_empty_principal_id_raises(self):
        with pytest.raises(InvalidMeteringEventError, match="principal_id"):
            _make_event(principal_id="")

    def test_empty_resource_type_raises(self):
        with pytest.raises(InvalidMeteringEventError, match="resource_type"):
            _make_event(resource_type="")

    def test_negative_quantity_raises(self):
        with pytest.raises(InvalidMeteringEventError, match="non-negative"):
            _make_event(quantity=Decimal("-1"))

    def test_zero_quantity_allowed(self):
        ev = _make_event(quantity=Decimal("0"))
        assert ev.quantity == Decimal("0")

    def test_non_decimal_quantity_raises(self):
        with pytest.raises(InvalidMeteringEventError, match="Decimal"):
            _make_event(quantity=1.0)

    def test_matches_resource_pattern_exact(self):
        ev = _make_event(resource_type="mcp.tool.search")
        assert ev.matches_resource_pattern("mcp.tool.search")
        assert not ev.matches_resource_pattern("mcp.tool.list")

    def test_matches_resource_pattern_wildcard(self):
        ev = _make_event(resource_type="mcp.tool.search")
        assert ev.matches_resource_pattern("mcp.tool.*")
        assert ev.matches_resource_pattern("mcp.*")
        assert not ev.matches_resource_pattern("mcp.resource.*")

    def test_to_dict(self):
        ev = _make_event(
            correlation_id="corr-1",
            source_event_id="src-1",
            tags=["prod", "api"],
            metadata={"x": 1},
        )
        d = ev.to_dict()
        assert d["principal_id"] == "pid-1"
        assert d["resource_type"] == "mcp.tool.search"
        assert d["quantity"] == "1.0"
        assert d["correlation_id"] == "corr-1"
        assert d["source_event_id"] == "src-1"
        assert "prod" in d["tags"]
        assert d["metadata"]["x"] == 1

    def test_from_dict(self):
        d = {
            "principal_id": "pid-2",
            "resource_type": "mcp.resource.read",
            "quantity": "2.5",
            "timestamp": "2026-01-01T00:00:00",
            "metadata": {},
            "correlation_id": None,
            "source_event_id": None,
            "tags": [],
        }
        ev = MeteringEvent.from_dict(d)
        assert ev.principal_id == "pid-2"
        assert ev.quantity == Decimal("2.5")

    def test_from_dict_no_timestamp(self):
        d = {
            "principal_id": "pid-1",
            "resource_type": "mcp.tool.search",
            "quantity": "1.0",
        }
        ev = MeteringEvent.from_dict(d)
        assert ev.timestamp is not None


@pytest.mark.unit
class TestMeteringCollector:
    def test_collect_event_succeeds(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event())
        assert ledger.append_event.called

    def test_collect_event_passes_principal_and_resource(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event(resource_type="mcp.resource.read"))
        call = ledger.append_event.call_args
        assert call.kwargs["principal_id"] == "pid-1"
        assert call.kwargs["resource_type"] == "mcp.resource.read"

    def test_collect_event_passes_quantity(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event(quantity=Decimal("5.0")))
        call = ledger.append_event.call_args
        assert call.kwargs["quantity"] == Decimal("5.0")

    def test_collect_event_passes_correlation_id(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event(correlation_id="corr-1"))
        call = ledger.append_event.call_args
        assert call.kwargs["metadata"]["correlation_id"] == "corr-1"

    def test_collect_event_passes_source_event_id(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event(source_event_id="src-1"))
        call = ledger.append_event.call_args
        assert call.kwargs["metadata"]["source_event_id"] == "src-1"

    def test_collect_event_passes_tags(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        collector.collect_event(_make_event(tags=["prod", "batch"]))
        call = ledger.append_event.call_args
        assert "prod" in call.kwargs["metadata"]["tags"]

    def test_collect_event_ledger_failure_raises_collection_error(self):
        ledger = _ledger_stub()
        ledger.append_event.side_effect = RuntimeError("ledger crash")
        collector = MeteringCollector(ledger)
        with pytest.raises(MeteringCollectionError):
            collector.collect_event(_make_event())

    def test_collect_invalid_event_raises_validation_error(self):
        ledger = _ledger_stub()
        collector = MeteringCollector(ledger)
        ev = _make_event()
        object.__setattr__(ev, "principal_id", "")
        with pytest.raises(InvalidMeteringEventError):
            collector.collect_event(ev)
