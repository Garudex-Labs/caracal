"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for MeteringCollector with enhanced MeteringEvent.

Tests the core functionality of collecting metering events with enhanced fields
(correlation_id, parent_event_id, tags) and writing to the ledger.
"""

from decimal import Decimal
from datetime import datetime

import pytest

from caracal.core.metering import MeteringCollector, MeteringEvent
from caracal.core.ledger import LedgerWriter
from caracal.exceptions import InvalidMeteringEventError, MeteringCollectionError


class TestMeteringCollectorWithEnhancedTypes:
    """Tests for MeteringCollector with enhanced MeteringEvent."""
    
    def test_collect_event_with_basic_fields(self, temp_dir):
        """Test collecting event with basic fields only."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1")
        )
        
        # Should not raise
        collector.collect_event(event)
        
        # Verify event was written to ledger
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        assert ledger_event["agent_id"] == "agent-123"
        assert ledger_event["resource_type"] == "mcp.tool.search"
        assert ledger_event["quantity"] == "1"
    
    def test_collect_event_with_correlation_id(self, temp_dir):
        """Test collecting event with correlation_id."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            correlation_id="trace-789"
        )
        
        collector.collect_event(event)
        
        # Verify correlation_id is in metadata
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        assert ledger_event["metadata"]["correlation_id"] == "trace-789"
    
    def test_collect_event_with_parent_event_id(self, temp_dir):
        """Test collecting event with parent_event_id."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            parent_event_id="event-456"
        )
        
        collector.collect_event(event)
        
        # Verify parent_event_id is in metadata
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        assert ledger_event["metadata"]["parent_event_id"] == "event-456"
    
    def test_collect_event_with_tags(self, temp_dir):
        """Test collecting event with tags."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            tags=["mcp", "search", "production"]
        )
        
        collector.collect_event(event)
        
        # Verify tags are in metadata
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        assert ledger_event["metadata"]["tags"] == ["mcp", "search", "production"]
    
    def test_collect_event_with_all_enhanced_fields(self, temp_dir):
        """Test collecting event with all enhanced fields."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            metadata={"tool_name": "search", "mandate_id": "mandate-456"},
            correlation_id="trace-789",
            parent_event_id="event-012",
            tags=["mcp", "search"]
        )
        
        collector.collect_event(event)
        
        # Verify all fields are in metadata
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        metadata = ledger_event["metadata"]
        assert metadata["tool_name"] == "search"
        assert metadata["mandate_id"] == "mandate-456"
        assert metadata["correlation_id"] == "trace-789"
        assert metadata["parent_event_id"] == "event-012"
        assert metadata["tags"] == ["mcp", "search"]
    
    def test_collect_event_validation_empty_agent_id(self, temp_dir):
        """Test that empty agent_id raises InvalidMeteringEventError."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Create event with empty agent_id (bypassing MeteringEvent validation)
        event = MeteringEvent.__new__(MeteringEvent)
        event.agent_id = ""
        event.resource_type = "test"
        event.quantity = Decimal("1")
        event.timestamp = datetime.utcnow()
        event.metadata = {}
        event.correlation_id = None
        event.parent_event_id = None
        event.tags = []
        
        with pytest.raises(InvalidMeteringEventError, match="agent_id must be a non-empty string"):
            collector.collect_event(event)
    
    def test_collect_event_validation_empty_resource_type(self, temp_dir):
        """Test that empty resource_type raises InvalidMeteringEventError."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Create event with empty resource_type (bypassing MeteringEvent validation)
        event = MeteringEvent.__new__(MeteringEvent)
        event.agent_id = "agent-123"
        event.resource_type = ""
        event.quantity = Decimal("1")
        event.timestamp = datetime.utcnow()
        event.metadata = {}
        event.correlation_id = None
        event.parent_event_id = None
        event.tags = []
        
        with pytest.raises(InvalidMeteringEventError, match="resource_type must be a non-empty string"):
            collector.collect_event(event)
    
    def test_collect_event_validation_negative_quantity(self, temp_dir):
        """Test that negative quantity raises InvalidMeteringEventError."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Create event with negative quantity (bypassing MeteringEvent validation)
        event = MeteringEvent.__new__(MeteringEvent)
        event.agent_id = "agent-123"
        event.resource_type = "test"
        event.quantity = Decimal("-1")
        event.timestamp = datetime.utcnow()
        event.metadata = {}
        event.correlation_id = None
        event.parent_event_id = None
        event.tags = []
        
        with pytest.raises(InvalidMeteringEventError, match="quantity must be non-negative"):
            collector.collect_event(event)
    
    def test_collect_event_validation_invalid_quantity_type(self, temp_dir):
        """Test that non-Decimal quantity raises InvalidMeteringEventError."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Create event with invalid quantity type (bypassing MeteringEvent validation)
        event = MeteringEvent.__new__(MeteringEvent)
        event.agent_id = "agent-123"
        event.resource_type = "test"
        event.quantity = 1  # int instead of Decimal
        event.timestamp = datetime.utcnow()
        event.metadata = {}
        event.correlation_id = None
        event.parent_event_id = None
        event.tags = []
        
        with pytest.raises(InvalidMeteringEventError, match="quantity must be a Decimal"):
            collector.collect_event(event)
    
    def test_collect_event_validation_invalid_timestamp_type(self, temp_dir):
        """Test that non-datetime timestamp raises InvalidMeteringEventError."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Create event with invalid timestamp type (bypassing MeteringEvent validation)
        event = MeteringEvent.__new__(MeteringEvent)
        event.agent_id = "agent-123"
        event.resource_type = "test"
        event.quantity = Decimal("1")
        event.timestamp = "2024-01-15T10:30:00Z"  # string instead of datetime
        event.metadata = {}
        event.correlation_id = None
        event.parent_event_id = None
        event.tags = []
        
        with pytest.raises(InvalidMeteringEventError, match="timestamp must be a datetime object"):
            collector.collect_event(event)
    
    def test_collect_multiple_events_with_enhanced_fields(self, temp_dir):
        """Test collecting multiple events with various enhanced fields."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Event 1: with correlation_id
        event1 = MeteringEvent(
            agent_id="agent-1",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            correlation_id="trace-1"
        )
        
        # Event 2: with parent_event_id
        event2 = MeteringEvent(
            agent_id="agent-2",
            resource_type="mcp.tool.analyze",
            quantity=Decimal("2"),
            parent_event_id="event-1"
        )
        
        # Event 3: with tags
        event3 = MeteringEvent(
            agent_id="agent-3",
            resource_type="mcp.tool.write",
            quantity=Decimal("3"),
            tags=["mcp", "write", "production"]
        )
        
        collector.collect_event(event1)
        collector.collect_event(event2)
        collector.collect_event(event3)
        
        # Verify all events were written
        with open(ledger_path, 'r') as f:
            import json
            lines = f.readlines()
        
        assert len(lines) == 3
        
        ledger_event1 = json.loads(lines[0])
        assert ledger_event1["metadata"]["correlation_id"] == "trace-1"
        
        ledger_event2 = json.loads(lines[1])
        assert ledger_event2["metadata"]["parent_event_id"] == "event-1"
        
        ledger_event3 = json.loads(lines[2])
        assert ledger_event3["metadata"]["tags"] == ["mcp", "write", "production"]
    
    def test_collect_event_preserves_existing_metadata(self, temp_dir):
        """Test that enhanced fields don't overwrite existing metadata."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            metadata={"custom_field": "custom_value", "another_field": 42},
            correlation_id="trace-789",
            tags=["mcp"]
        )
        
        collector.collect_event(event)
        
        # Verify both custom metadata and enhanced fields are present
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        metadata = ledger_event["metadata"]
        assert metadata["custom_field"] == "custom_value"
        assert metadata["another_field"] == 42
        assert metadata["correlation_id"] == "trace-789"
        assert metadata["tags"] == ["mcp"]
    
    def test_collect_event_with_empty_tags_list(self, temp_dir):
        """Test that empty tags list is not added to metadata."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        event = MeteringEvent(
            agent_id="agent-123",
            resource_type="mcp.tool.search",
            quantity=Decimal("1"),
            tags=[]  # Empty list
        )
        
        collector.collect_event(event)
        
        # Verify tags are not in metadata when empty
        with open(ledger_path, 'r') as f:
            import json
            line = f.readline()
            ledger_event = json.loads(line)
        
        # Empty list should not be added to metadata
        assert "tags" not in ledger_event.get("metadata", {})
    
    def test_collect_event_ledger_integration(self, temp_dir):
        """Test that MeteringCollector properly integrates with LedgerWriter."""
        ledger_path = temp_dir / "ledger.jsonl"
        ledger_writer = LedgerWriter(str(ledger_path))
        collector = MeteringCollector(ledger_writer)
        
        # Collect multiple events
        for i in range(5):
            event = MeteringEvent(
                agent_id=f"agent-{i}",
                resource_type="test.resource",
                quantity=Decimal(str(i * 100)),
                correlation_id=f"trace-{i}"
            )
            collector.collect_event(event)
        
        # Verify all events have monotonic IDs
        with open(ledger_path, 'r') as f:
            import json
            lines = f.readlines()
        
        assert len(lines) == 5
        
        for i, line in enumerate(lines):
            ledger_event = json.loads(line)
            assert ledger_event["event_id"] == i + 1
            assert ledger_event["agent_id"] == f"agent-{i}"
            assert ledger_event["metadata"]["correlation_id"] == f"trace-{i}"
