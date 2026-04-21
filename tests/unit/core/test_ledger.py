"""
Unit tests for Caracal ledger module.
"""
import pytest
from datetime import datetime, timedelta
from decimal import Decimal
from uuid import uuid4
from unittest.mock import Mock, MagicMock

from caracal.core.ledger import LedgerWriter, LedgerQuery, LedgerEvent
from caracal.exceptions import InvalidLedgerEventError, LedgerReadError, LedgerWriteError


@pytest.fixture
def mock_session():
    """Provide a mock database session."""
    session = Mock()
    session.add = Mock()
    session.flush = Mock()
    session.commit = Mock()
    session.rollback = Mock()
    session.query = Mock()
    return session


@pytest.fixture
def sample_principal_id():
    """Provide a sample principal UUID."""
    return str(uuid4())


@pytest.fixture
def sample_ledger_event_data(sample_principal_id):
    """Provide sample ledger event data."""
    return {
        "event_id": 1,
        "principal_id": sample_principal_id,
        "timestamp": "2024-01-15T10:00:00Z",
        "resource_type": "api:openai:gpt-4",
        "quantity": "100.50",
        "metadata": {"model": "gpt-4", "tokens": 100}
    }


@pytest.mark.unit
class TestLedgerEvent:
    """Test LedgerEvent dataclass."""
    
    def test_ledger_event_creation(self, sample_ledger_event_data):
        """Test creating a LedgerEvent."""
        event = LedgerEvent(**sample_ledger_event_data)
        
        assert event.event_id == sample_ledger_event_data["event_id"]
        assert event.principal_id == sample_ledger_event_data["principal_id"]
        assert event.timestamp == sample_ledger_event_data["timestamp"]
        assert event.resource_type == sample_ledger_event_data["resource_type"]
        assert event.quantity == sample_ledger_event_data["quantity"]
        assert event.metadata == sample_ledger_event_data["metadata"]
    
    def test_ledger_event_to_dict(self, sample_ledger_event_data):
        """Test converting LedgerEvent to dictionary."""
        event = LedgerEvent(**sample_ledger_event_data)
        event_dict = event.to_dict()
        
        assert event_dict["event_id"] == sample_ledger_event_data["event_id"]
        assert event_dict["principal_id"] == sample_ledger_event_data["principal_id"]
        assert event_dict["timestamp"] == sample_ledger_event_data["timestamp"]
        assert event_dict["resource_type"] == sample_ledger_event_data["resource_type"]
        assert event_dict["quantity"] == sample_ledger_event_data["quantity"]
        assert event_dict["metadata"] == sample_ledger_event_data["metadata"]
    
    def test_ledger_event_from_dict(self, sample_ledger_event_data):
        """Test creating LedgerEvent from dictionary."""
        event = LedgerEvent.from_dict(sample_ledger_event_data)
        
        assert event.event_id == sample_ledger_event_data["event_id"]
        assert event.principal_id == sample_ledger_event_data["principal_id"]
        assert event.timestamp == sample_ledger_event_data["timestamp"]
    
    def test_ledger_event_without_metadata(self, sample_principal_id):
        """Test creating LedgerEvent without metadata."""
        data = {
            "event_id": 1,
            "principal_id": sample_principal_id,
            "timestamp": "2024-01-15T10:00:00Z",
            "resource_type": "api:openai:gpt-4",
            "quantity": "100.50"
        }
        event = LedgerEvent(**data)
        event_dict = event.to_dict()
        
        assert event.metadata is None
        assert "metadata" not in event_dict


@pytest.mark.unit
class TestLedgerWriter:
    """Test LedgerWriter class."""
    
    def test_ledger_writer_creation(self, mock_session):
        """Test creating a LedgerWriter."""
        writer = LedgerWriter(mock_session)
        
        assert writer.session == mock_session
        assert writer.backup_count == 3
    
    def test_append_event_success(self, mock_session, sample_principal_id):
        """Test successfully appending an event."""
        writer = LedgerWriter(mock_session)
        
        # Mock the database row
        mock_row = Mock()
        mock_row.event_id = 1
        mock_row.principal_id = sample_principal_id
        mock_row.timestamp = datetime(2024, 1, 15, 10, 0, 0)
        mock_row.resource_type = "api:openai:gpt-4"
        mock_row.quantity = Decimal("100.50")
        mock_row.event_metadata = {"model": "gpt-4"}
        
        # Configure mock session to return the row
        mock_session.add = Mock()
        mock_session.flush = Mock()
        mock_session.commit = Mock()
        
        # Simulate the row being added
        def add_side_effect(row):
            row.event_id = mock_row.event_id
            row.principal_id = mock_row.principal_id
            row.timestamp = mock_row.timestamp
            row.resource_type = mock_row.resource_type
            row.quantity = mock_row.quantity
            row.event_metadata = mock_row.event_metadata
        
        mock_session.add.side_effect = add_side_effect
        
        event = writer.append_event(
            principal_id=sample_principal_id,
            resource_type="api:openai:gpt-4",
            quantity=Decimal("100.50"),
            metadata={"model": "gpt-4"}
        )
        
        assert event.event_id == 1
        assert event.principal_id == sample_principal_id
        assert event.resource_type == "api:openai:gpt-4"
        assert event.quantity == "100.50"
        assert event.metadata == {"model": "gpt-4"}
        
        mock_session.add.assert_called_once()
        mock_session.flush.assert_called_once()
        mock_session.commit.assert_called_once()
    
    def test_append_event_empty_principal_id(self, mock_session):
        """Test appending event with empty principal_id."""
        writer = LedgerWriter(mock_session)
        
        with pytest.raises(InvalidLedgerEventError, match="principal_id cannot be empty"):
            writer.append_event(
                principal_id="",
                resource_type="api:openai:gpt-4",
                quantity=Decimal("100.50")
            )
    
    def test_append_event_empty_resource_type(self, mock_session, sample_principal_id):
        """Test appending event with empty resource_type."""
        writer = LedgerWriter(mock_session)
        
        with pytest.raises(InvalidLedgerEventError, match="resource_type cannot be empty"):
            writer.append_event(
                principal_id=sample_principal_id,
                resource_type="",
                quantity=Decimal("100.50")
            )
    
    def test_append_event_negative_quantity(self, mock_session, sample_principal_id):
        """Test appending event with negative quantity."""
        writer = LedgerWriter(mock_session)
        
        with pytest.raises(InvalidLedgerEventError, match="quantity must be non-negative"):
            writer.append_event(
                principal_id=sample_principal_id,
                resource_type="api:openai:gpt-4",
                quantity=Decimal("-10.0")
            )
    
    def test_append_event_invalid_principal_uuid(self, mock_session):
        """Test appending event with invalid principal UUID."""
        writer = LedgerWriter(mock_session)
        
        with pytest.raises(InvalidLedgerEventError, match="Invalid principal_id UUID"):
            writer.append_event(
                principal_id="not-a-uuid",
                resource_type="api:openai:gpt-4",
                quantity=Decimal("100.50")
            )
    
    def test_append_event_database_error(self, mock_session, sample_principal_id):
        """Test appending event with database error."""
        writer = LedgerWriter(mock_session)
        
        # Simulate database error
        mock_session.add.side_effect = Exception("Database error")
        
        with pytest.raises(LedgerWriteError, match="Failed to append event"):
            writer.append_event(
                principal_id=sample_principal_id,
                resource_type="api:openai:gpt-4",
                quantity=Decimal("100.50")
            )
        
        mock_session.rollback.assert_called_once()


@pytest.mark.unit
class TestLedgerQuery:
    """Test LedgerQuery class."""
    
    def test_ledger_query_creation(self, mock_session):
        """Test creating a LedgerQuery."""
        query = LedgerQuery(mock_session)
        
        assert query.session == mock_session
    
    def test_get_events_no_filters(self, mock_session, sample_principal_id):
        """Test getting events without filters."""
        query_obj = LedgerQuery(mock_session)
        
        # Mock database rows
        mock_row = Mock()
        mock_row.event_id = 1
        mock_row.principal_id = sample_principal_id
        mock_row.timestamp = datetime(2024, 1, 15, 10, 0, 0)
        mock_row.resource_type = "api:openai:gpt-4"
        mock_row.quantity = Decimal("100.50")
        mock_row.event_metadata = {"model": "gpt-4"}
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[mock_row])
        
        mock_session.query = Mock(return_value=mock_query)
        
        events = query_obj.get_events()
        
        assert len(events) == 1
        assert events[0].event_id == 1
        assert events[0].principal_id == sample_principal_id
        assert events[0].resource_type == "api:openai:gpt-4"
    
    def test_get_events_with_principal_filter(self, mock_session, sample_principal_id):
        """Test getting events filtered by principal_id."""
        query_obj = LedgerQuery(mock_session)
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[])
        
        mock_session.query = Mock(return_value=mock_query)
        
        events = query_obj.get_events(principal_id=sample_principal_id)
        
        assert len(events) == 0
        mock_query.filter.assert_called()
    
    def test_get_events_with_time_filters(self, mock_session):
        """Test getting events filtered by time range."""
        query_obj = LedgerQuery(mock_session)
        
        start_time = datetime(2024, 1, 15, 10, 0, 0)
        end_time = datetime(2024, 1, 15, 11, 0, 0)
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[])
        
        mock_session.query = Mock(return_value=mock_query)
        
        events = query_obj.get_events(start_time=start_time, end_time=end_time)
        
        assert len(events) == 0
        assert mock_query.filter.call_count >= 2
    
    def test_get_events_with_resource_type_filter(self, mock_session):
        """Test getting events filtered by resource_type."""
        query_obj = LedgerQuery(mock_session)
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[])
        
        mock_session.query = Mock(return_value=mock_query)
        
        events = query_obj.get_events(resource_type="api:openai")
        
        assert len(events) == 0
        mock_query.filter.assert_called()
    
    def test_get_events_database_error(self, mock_session):
        """Test getting events with database error."""
        query_obj = LedgerQuery(mock_session)
        
        # Simulate database error
        mock_session.query.side_effect = Exception("Database error")
        
        with pytest.raises(LedgerReadError, match="Failed to query PostgreSQL ledger"):
            query_obj.get_events()
    
    def test_sum_usage(self, mock_session, sample_principal_id):
        """Test summing usage for a principal."""
        query_obj = LedgerQuery(mock_session)
        
        # Mock multiple events
        mock_row1 = Mock()
        mock_row1.event_id = 1
        mock_row1.principal_id = sample_principal_id
        mock_row1.timestamp = datetime(2024, 1, 15, 10, 0, 0)
        mock_row1.resource_type = "api:openai:gpt-4"
        mock_row1.quantity = Decimal("100.50")
        mock_row1.event_metadata = {}
        
        mock_row2 = Mock()
        mock_row2.event_id = 2
        mock_row2.principal_id = sample_principal_id
        mock_row2.timestamp = datetime(2024, 1, 15, 11, 0, 0)
        mock_row2.resource_type = "api:openai:gpt-4"
        mock_row2.quantity = Decimal("50.25")
        mock_row2.event_metadata = {}
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[mock_row1, mock_row2])
        
        mock_session.query = Mock(return_value=mock_query)
        
        start_time = datetime(2024, 1, 15, 9, 0, 0)
        end_time = datetime(2024, 1, 15, 12, 0, 0)
        
        total = query_obj.sum_usage(sample_principal_id, start_time, end_time)
        
        assert total == Decimal("150.75")
    
    def test_aggregate_by_agent(self, mock_session):
        """Test aggregating usage by agent."""
        query_obj = LedgerQuery(mock_session)
        
        principal_id1 = str(uuid4())
        principal_id2 = str(uuid4())
        
        # Mock events for different principals
        mock_row1 = Mock()
        mock_row1.event_id = 1
        mock_row1.principal_id = principal_id1
        mock_row1.timestamp = datetime(2024, 1, 15, 10, 0, 0)
        mock_row1.resource_type = "api:openai:gpt-4"
        mock_row1.quantity = Decimal("100.50")
        mock_row1.event_metadata = {}
        
        mock_row2 = Mock()
        mock_row2.event_id = 2
        mock_row2.principal_id = principal_id2
        mock_row2.timestamp = datetime(2024, 1, 15, 11, 0, 0)
        mock_row2.resource_type = "api:openai:gpt-4"
        mock_row2.quantity = Decimal("50.25")
        mock_row2.event_metadata = {}
        
        mock_row3 = Mock()
        mock_row3.event_id = 3
        mock_row3.principal_id = principal_id1
        mock_row3.timestamp = datetime(2024, 1, 15, 12, 0, 0)
        mock_row3.resource_type = "api:openai:gpt-4"
        mock_row3.quantity = Decimal("25.00")
        mock_row3.event_metadata = {}
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[mock_row1, mock_row2, mock_row3])
        
        mock_session.query = Mock(return_value=mock_query)
        
        start_time = datetime(2024, 1, 15, 9, 0, 0)
        end_time = datetime(2024, 1, 15, 13, 0, 0)
        
        totals = query_obj.aggregate_by_principal(start_time, end_time)
        
        assert totals[principal_id1] == Decimal("125.50")
        assert totals[principal_id2] == Decimal("50.25")
    
    def test_get_usage_breakdown(self, mock_session, sample_principal_id):
        """Test getting usage breakdown for a principal."""
        query_obj = LedgerQuery(mock_session)
        
        # Mock event
        mock_row = Mock()
        mock_row.event_id = 1
        mock_row.principal_id = sample_principal_id
        mock_row.timestamp = datetime(2024, 1, 15, 10, 0, 0)
        mock_row.resource_type = "api:openai:gpt-4"
        mock_row.quantity = Decimal("100.50")
        mock_row.event_metadata = {}
        
        # Configure mock query chain
        mock_query = Mock()
        mock_query.filter = Mock(return_value=mock_query)
        mock_query.order_by = Mock(return_value=mock_query)
        mock_query.all = Mock(return_value=[mock_row])
        
        mock_session.query = Mock(return_value=mock_query)
        
        start_time = datetime(2024, 1, 15, 9, 0, 0)
        end_time = datetime(2024, 1, 15, 12, 0, 0)
        
        breakdown = query_obj.get_usage_breakdown(sample_principal_id, start_time, end_time)
        
        assert breakdown["principal_id"] == sample_principal_id
        assert breakdown["usage"] == "100.50"
        assert breakdown["total_with_targetren"] == "100.50"
        assert breakdown["targetren"] == []
